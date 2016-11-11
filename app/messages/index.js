'use strict';
const nats = require('nats').connect({ json: true });
const Router = require('./router');
const buildHandler = require('./build');

function init() {
  const controllerEngineRouter = new Router({ nats, channel: 'controller.engine' });

  controllerEngineRouter.addRoute('BUILD', buildHandler);

  controllerEngineRouter.start();
}

module.exports = {
  init
};
