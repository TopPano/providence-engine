'use strict';
const BuildController = require('../controller/build');

module.exports = function({ nats, channelId, payload }) {
  const buildController = new BuildController(payload)

  buildController.on('message', (message) => {
    nats.publish(`engine.${channelId}.build.message`, { data: message.toString() });
  });

  buildController.on('error', (error) => {
    const command = { type: 'ERROR', payload: error };
    nats.publish(`engine.${channelId}.build.control`, command);
  });

  buildController.on('end', () => {
    const command = { type: 'END' };
    nats.publish(`engine.${channelId}.build.control`, command);
  });

  buildController.start();
}
