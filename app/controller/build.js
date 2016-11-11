'use strict';
const async = require('async');
const fs = require('fs');
const yaml = require('yamljs');
const Docker = require('dockerode');
const randomstring = require('randomstring');
const Etcd = require('node-etcd');
const rimraf = require('rimraf');
const AWS = require('aws-sdk');
const tarfs = require('tar-fs');
const tar = require('tar');
const streamifier = require('streamifier');
const zlib = require('zlib');
const path = require('path');
const EventEmitter = require('events');
const winston = require('winston');

const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({})
  ]
});

const config = require('../../config');

const DEFAULT_ENGINEFILE_NAME = 'Enginefile';
const DEFAULT_COMPONENT_BASE = 'provbase';

let docker;
if (config.dockerLocal.socketPath) {
  docker = new Docker({ socketPath: config.dockerLocal.socketPath });
}
else{
  docker = new Docker();
}
const etcd = new Etcd(config.etcd.host);


class BuildController extends EventEmitter {
  constructor(params) {
    super(params);
    if (!params.enginePackage) {
      throw new Error('No engine package found');
    }
    this._buildOptions = params.buildOptions;
    this._enginePackage = Buffer.from(params.enginePackage, 'base64');

    this.progressHandler = this.progressHandler.bind(this);
  }

  progressHandler(progress) {
    this.emit('message', progress);
  }

  start() {
    let context = {
      engineId: idGen(),
      buildOptions: this._buildOptions,
      enginePackage: this._enginePackage
    };

    async.series([
      (cb) => {
        logger.info('Unpacking the engine package...');
        unpack(context.enginePackage, (err, folder) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done.')
          context['engineTempDir'] = folder;
          cb();
        });
      },

      (cb) => {
        logger.info('Generating engine Dockerfile...');
        genEngineDockerfile(context.engineTempDir, context.buildOptions, (err) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done.')
          cb();
        });
      },

      (cb) => {
        logger.info('Bulding docker image for the engine...');
        buildDockerImage(context.engineTempDir, context.engineId, this.progressHandler, (err, tag) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done');
          context['dockerImageTag'] = tag;
          cb();
        });
      },

      (cb) => {
        logger.info('Pushing docker image to Docker Registry...');
        pushToDockerRegistry(context.dockerImageTag, progressHandler, (err) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done.');
          cb();
        });
      },

      (cb) => {
        logger.info('Saving engine pacakge...');
        saveEnginePackage(context.engineId, context.enginePackage, (err, result)  => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done');
          context['blobKey'] = result.key;
          context['blobEtag'] = result.etag;
          cb();
        });
      },

      (cb) => {
        const metadata = {
          status: 'completed',
          blobKey: context.blobKey,
          blobEtag: context.blobEtag
        };
        logger.info('Saving engine instance metadata...');
        saveEngineMetadata(context.engineId, metadata, (err) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done');
          cb();
        });
      },

      (cb) => {
        logger.info('Cleaning up...');
        cleanup(context, (err) => {
          if (err) {
            logger.error(err);
            return cb(err);
          }
          logger.info('Done');
          cb();
        });
      }
    ], (err) => {
      if (err) {
        cleanup(context, (err) => {
          logger.error(err);
        });
        return this.emit('error', err);
      }
      logger.info('Built engine instance successfully.');
      this.emit('end');
    });
  }
}

function idGen() {
  return randomstring.generate({
    length: 10,
    charset: 'alphabetic',
    capitalization: 'lowercase'
  });
}

function unpack(content, callback) {
  if (!content) {
    return callback(new Error('Package not found'));
  }
  if (!Buffer.isBuffer(content)) {
    return callback(new Error('Package is not a buffer'));
  }

  //----- write file under /tmp with random string directory
  fs.mkdtemp('/tmp/engine-', (err, folder) => {
    if (err) { return callback(err); }
    zlib.gunzip(content, (err, unzipped) => {
      if (err) { return callback(err); }
      untar(folder, unzipped, (err) => {
        if (err) { callback(err); }
        callback(null, folder);
      });
    });
  });

  function untar(folder, tarfile, callback) {
    let hasError = false;
    const extractor = tar.Extract({ path: folder });
    extractor.on('error', (error) => {
      if (!hasError) {
        hasError = true;
        callback(error);
      }
    });
    extractor.on('end', () => {
      if (!hasError) {
        callback();
      }
    });
    streamifier.createReadStream(tarfile)
    .on('error', (error) => {
      if (!hasError) {
        hasError = true;
        callback(error);
      }
    })
    .pipe(extractor);
  }
}

function genEngineDockerfile(contextDir, buildOptions, callback) {
  if (!contextDir) {
    return new Error('Temp engine directory was not found!');
  }

  const enginefileName = buildOptions.enginefileName ?
                          buildOptions.enginefileName :
                          DEFAULT_ENGINEFILE_NAME;

  // parse engine.yml
  const enginefile = yaml.load(contextDir + '/' + enginefileName);

  const { entry, components } = enginefile;

  let engineDockerfileStr = '';

  // Add base image
  engineDockerfileStr += `FROM ${components.base ? components.base : DEFAULT_COMPONENT_BASE}\n`;
  engineDockerfileStr += '\n\n';

  // Mount the 'folder'(local) volume to the docker container
  engineDockerfileStr += 'RUN mkdir /engine\n';
  engineDockerfileStr += 'ADD . engine\n';
  engineDockerfileStr += 'WORKDIR /engine\n';
  engineDockerfileStr += 'RUN ls /engine\n';
  engineDockerfileStr += '\n\n';

  // Build components
  Object.keys(components).forEach((component) => {
    try {
      if (component === 'base') {
        // skip base
        return;
      }
      if (fs.lstatSync(path.resolve(contextDir, 'components', component, 'src/CMakeLists.txt'))) {
        engineDockerfileStr += `RUN mkdir /engine/components/${component}/build\n`;
        engineDockerfileStr += `RUN cd /engine/components/${component}/build && \\ \n`;
        engineDockerfileStr += `    cmake ../src && \\\n`;
        engineDockerfileStr += `    make\n`;
        engineDockerfileStr += '\n\n';
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return callback(err);
      }
    }
  });

  // Generate main python script


  // Write down the engine Dockerfile
  fs.writeFile(path.resolve(contextDir, 'Dockerfile'), engineDockerfileStr, (err) => {
    if(err) { return callback(err); }
    callback();
  });
}

function buildDockerImage(contextDir, engineId, progressHandler, callback) {
  const tarStream = tarfs.pack(contextDir);
  const tag = `${config.dockerRegistry.host}/${engineId}`;

  docker.buildImage(tarStream, { t: tag }, function (err, stream){
    if (err) { return callback(err); }
    stream.on('data', (data) => {
      progressHandler(data);
    });
    stream.on('error', (error) => {
      callback(error);
    });
    stream.on('end', () => {
      callback(null, tag);
    });
  });
}

function pushToDockerRegistry(tag, progressHandler, callback) {
  const dockerPush = require('child_process').spawn('docker', ['push', tag]);
  dockerPush.stdout.on('data', (data) => {
    progressHandler(data);
  });

  dockerPush.on('close', (code) => {
    if (code !== 0) {
      const error = new Error(`Error occurred while pushing to Docker registry, error code: ${code}`);
      return calblack(error);
    }
    callback();
  });
}

function saveEnginePackage(engineId, enginePackage, callback) {
  const s3 = new AWS.S3();
  const Key = `engine/${engineId}.tgz`;

  const params = {
    Bucket: config.store.bucket,
    Key,
    Body: enginePackage,
    ACL: 'private',
    ContentType: 'application/tar',
    StorageClass: 'STANDARD'
  };
  const uploader = s3.putObject(params, (err, res) => {
    if (err) {
      callback(err);
    }
    callback(null, {
      etag: res.ETag,
      key: Key
    });
  });
}

function saveEngineMetadata(key, metadata, callback) {
  if (typeof metadata === 'object') {
    metadata = JSON.stringify(metadata);
  }
  etcd.set(`engine/${key}`, metadata, (err) => {
    if (err) { return callback(err); }
    callback();
  });
}

function cleanup(context, callback) {
  async.parallel({
    removeTempDir: (cb) => {
      rimraf(context.engineTempDir, (err) => {
        if (err) { return cb(err); }
        cb();
      });
    },
    removeLocalDockerImage: (cb) => {
      const image = docker.getImage(context.dockerImageTag);
      image.inspect((err) => {
        if (err) {
          if (err.statusCode === 404) {
            return cb();
          }
          return cb(err);
        }
        image.remove((err) => {
          if (err) { return cb(err); }
          cb();
        });
      });
    }
  }, (err) => {
    if (err) { return callback(err); }
    callback();
  });
}

module.exports = BuildController;
