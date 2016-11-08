'use strict';

module.exports = {
  etcd: {
    host: '192.168.1.176:237'
  },
  dockerRegistry: {
    host: '192.168.1.176:5000'
  },
  dockerLocal: {
    socketPath: '/var/run/docker.sock'
  },
  nats: {
    host: '192.168.1.176',
    port: 4222
  },
  store: {
    bucket: 'toppano-providence-test',
    accessKeyId: 'AKIAINPBPUAXVP3RZCOQ',
    accessSecretKey: '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'
  },
};

