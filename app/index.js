var async = require('async');
var fs = require('fs');
var nats = require('nats').connect();
var mkdirp = require('mkdirp');
var yaml = require('yamljs');
var Docker = require('dockerode');
var tar = require('tar-fs');

var docker = new Docker({socketPath: '/var/run/docker.sock'});

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

    //----- build the image
    (folder, cb) => {
      var tarStream = tar.pack(folder);
      docker.buildImage(tarStream, {t: 'test'}, function (err, stream){
        if(err){return cb(err);}
        stream.on('data', function(data){
          // console.log(data.toString());
          nats.publish('controller', data);
        });

        stream.on('end', (data) => {
          cb(null, folder);
        })
      });
    }
    //----- push docker registry
    //----- push image metadata in etcd
    //----- delete tmp file and local docker image
  ); // mainFlow


  mainFlow(0, function(err, res){
    if(err){console.log(err);}
    console.log('finish build: '+res)
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

