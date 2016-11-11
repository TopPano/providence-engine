'use strict';

class Router {
  constructor(params) {
    if (!params.channel) {
      throw new Error('Channel not specified');
    }
    if (!params.nats) {
      throw new Error('NATS client not specified');
    }
    this._nats = params.nats;
    this._channel = params.channel;
    this._routeTable = {};
  }

  addRoute(type, handler) {
    if (this._routeTable[type]) {
      return;
    } else {
      this._routeTable[type] = handler;
    }
  }

  start() {
    this._nats.subscribe(this._channel, this._channelHandler().bind(this));
  }

  _channelHandler() {
    const nats = this._nats;
    const routeTable = this._routeTable;

    return (message) => {
      const { type, channelId, payload } = message;
      const handler = routeTable[type];
      if (!handler) {
        return console.error('Invalid message type: ' + type);
      }
      handler({ nats, channelId, payload });
    }
  }
}

module.exports = Router;
