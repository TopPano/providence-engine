'use strict';
var async = require('async');
var fs = require('fs');
var nats = require('nats').connect();
var mkdirp = require('mkdirp');
var yaml = require('yamljs');
var Docker = require('dockerode');
var tar = require('tar-fs');
var randomstr = require('randomstring');
var s3 = require('s3');
var Etcd = require('node-etcd');
var rimraf = require('rimraf');

var config = require('../config');

var docker;
if (config.dockerLocal.socketPath) {
  docker = new Docker({socketPath: config.dockerLocal.socketPath});
}
else if (config.dockerLocal.host) {
  docker = new Docker({host: config.dockerLocal.host});
}
else{
  console.log('In setting up dockerLocal');
  process.exit(1);
}
var etcd = new Etcd(config.etcd.host);


function build(engineMeta){
  var mainFlow = async.seq( 
    //----- write file under /tmp with random string directory after receiving data  
    (unused, cb) => {
      fs.mkdtemp('/tmp/engine-', (err, folder) => {
        if (err){ return cb(err); }
        cb(null, folder)
      })
    }, 
    //----- write engine.yml
    (folder, cb) => {
      fs.writeFile(folder+'/engine.yml', engineMeta.engine_yml, 'utf8', (err) => {
        if (err){ return cb(err); }
        cb(null, folder)
      });
    },
    //----- write each component file 
    (folder, cb) => {
      async.each(engineMeta.components, 
        (comp, compCb) => {
          var compPath = folder+'/'+comp.name;
          mkdirp(compPath, (err) => {
            if(err){return compCb(err);}
            fs.writeFile(compPath+'/'+comp.name+'.py', comp.data.toString(), 'utf8', 
              (err) => {
                if(err) {return compCb(err)}
                compCb(null);
              });
          })
        }, 
        (err) => {
          if(err){cb(err);}
          cb(null, folder);
        });
    },
    //----- gen a new Dockerfile based on base/Dockerfile and engine.yml
    (folder, cb) => {
      var dockerFileStr = engineMeta.base.Dockerfile;
      
      dockerFileStr += 'RUN mkdir /engine\n';   
      // mount the 'folder'(local) volume to the docker container
      dockerFileStr += 'ADD . engine\n';
      dockerFileStr += 'WORKDIR /engine\n';
      
      // parse engine.yml
      var engineYml = yaml.parse(engineMeta.engine_yml);
      var comps = engineYml.components;
      var currCompName = engineYml.main;
      var currCompObj = comps[currCompName];

      async.until(
        () => {
          if ( currCompObj.forward_to === 'output' ) {
           return true;
          }
          else if ( !(currCompObj.forward_to in comps) ) {
            return true;
          }
          else{
            return false;
          }
        },
        (untilCb) => {
          currCompName = currCompObj.forward_to;
          currCompObj = comps[currCompName];
          dockerFileStr += 'RUN python '+currCompName + '/' +currCompName + '.py\n';
          untilCb(null);
        },
        () => {
          console.log('finish gen Dockerfile');
          fs.writeFile(folder+'/Dockerfile', dockerFileStr, (err) => {
            if(err) {return cb(err);}
            cb(null, folder);
          });
        }
      );
    },
    //----- push the directory to S3 & gen engineId as S3 folder prefix
    (folder, cb) => {
      var engineId = randomstr.generate({
        length: 10,
        capitalization: 'lowercase'
      });
      var client = s3.createClient({
        maxAsyncS3: 20,     // this is the default 
        s3RetryCount: 3,    // this is the default 
        s3RetryDelay: 1000, // this is the default 
        s3Options: {
          accessKeyId: config.store.accessKeyId,
          secretAccessKey: config.store.accessSecretKey,
        },
      });

      var params = {
        localDir: folder,
        deleteRemoved: true,  
        s3Params: {
          Bucket: config.store.bucket,
          Prefix: 'engine/'+engineId,
        },
      };
      var uploader = client.uploadDir(params);
      uploader.on('error', function(err) {
        console.error("unable to sync:", err.stack);
      });
      uploader.on('progress', function() {
        //console.log("progress", uploader.progressAmount, uploader.progressTotal);
      });
      uploader.on('end', function(err, res) {
        console.log("done uploading");
        var storeUrl = s3.getPublicUrlHttp(config.store.bucket, 'engine/'+engineId)
        cb(null, {folder:folder, engineId:engineId, storeUrl: storeUrl});
      });
    },

    //----- build the image 
    (result, cb) => {
      var folder = result.folder;
      var engineId = result.engineId;
      var tarStream = tar.pack(folder);
      var tag = config.dockerRegistry.host + '/' + engineId;
      docker.buildImage(tarStream, {t: tag}, function (err, stream){
        if(err){return cb(err);}
        stream.on('data', function(data){
          nats.publish('controller', data);
        });
        stream.on('end', (data) => {
          result.tag = tag;
          cb(null, result);
        })
      });
    },
    //----- push docker registry 
    (result, cb) => {
      var dockerPush = require('child_process').spawn('docker', ['push', result.tag]);
      dockerPush.stdout.on('data', (data) => {
        // console.log(`stdout: ${data}`);
      });

      dockerPush.on('close', (code) => {
        // console.log(`child process exited with code ${code}`);
        cb(null, result);
      });
    },

    //----- push image metadata in etcd
    (result, cb) => {
      var key = result.engineId;
      var value = {};
      value.status = 'completed';
      value.storeUrl = result.storeUrl;
      etcd.set('engine/'+key, JSON.stringify(value), (err,res) => {console.log(JSON.stringify(err,null,2));
        cb(null, result);
      });  
    },
    //----- delete tmp file and local docker image
    (result, cb) => {
      rimraf(result.folder, (err) => {
        //console.log(err);
        var delLocalImg = require('child_process').spawn('docker', ['rmi', result.tag]);
        delLocalImg.on('close', (code) => {
          cb(null, result);
          // console.log(`child process exited with code ${code}`);
        });
      });
    }
  ); // mainFlow


  mainFlow(0, function(err, res){
    if(err){console.log(err);}
    console.log('finish build: '+JSON.stringify(res))
    //nats.close();
  });

}


// nats subscribe controller channel
nats.subscribe('foo', {'queue':'job.workers'}, function(msg) {
  var msg = JSON.parse(msg);
  switch (msg.command) {
    case 'build':
      build(msg.content);
      break;
    default:
      break;
  }
});

