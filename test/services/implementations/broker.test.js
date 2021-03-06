var
  q = require('q'),
  rewire = require('rewire'),
  sinon = require('sinon'),
  sandbox = sinon.sandbox.create(),
  should = require('should'),
  CircularList = require('easy-circular-list'),
  WSClientMock = require('../../mocks/services/ws.mock'),
  WSServerMock = require('../../mocks/services/ws.server.mock'),
  BrokerFactory = rewire('../../../lib/services/broker'),
  InternalError = require('kuzzle-common-objects').Errors.internalError,
  WSBrokerClient = require.main.require('lib/services/broker/wsBrokerClient'),
  WSBrokerServer = require.main.require('lib/services/broker/wsBrokerServer'),
  WSBrokerServerRewire = rewire('../../../lib/services/broker/wsBrokerServer');

describe('Test: Internal broker', function () {
  var
    clock,
    server,
    kuzzle;

  before(() => {
    kuzzle = {
      config: {
        internalBroker: {
          host: 'host',
          port: 'port',
          retryInterval: 1000
        }
      },
      pluginsManager: {
        trigger: sinon.stub()
      }
    };

    clock = sinon.useFakeTimers(new Date().getTime());
  });

  beforeEach(() =>{
    kuzzle.pluginsManager.trigger = sinon.stub();
    sandbox.restore();
  });

  after(() => {
    clock.restore();
  });

  describe('Internal broker general constructor', () => {
    it('should return a Broker', () => {
      var InternalBroker = new BrokerFactory('internalBroker', false, false);
      should(InternalBroker).be.Function();
    });
  });

  describe('Internal broker constructor', () => {
    it('should fail if no config match the broker type', () => {
      var FakeBroker = new BrokerFactory('fakeBroker');
      should((function () {new FakeBroker(kuzzle, {isServer: true});})).throw(Error);
    });
  });

  describe('Internal broker', () => {
    var
      client;

    beforeEach(() => {
      var InternalBroker = new BrokerFactory('internalBroker');
      /** @type InternalBroker */
      server = new InternalBroker(kuzzle, {isServer: true});
      server.ws = (options, cb) => {
        cb();
        return new WSServerMock();
      };

      /** @type InternalBroker */
      client = new InternalBroker(kuzzle, {isServer: false});
      client.ws = () => new WSClientMock(server.server);

      return q.all([
        server.init(),
        client.init()
      ]);
    });

    it('should instanciate a broker', () => {
      should(client).be.an.instanceOf(WSBrokerClient);
      should(server).be.an.instanceOf(WSBrokerServer);
    });

    it('should return a rejected promise when calling waitForClients on a client handler', () => {
      return should(client.waitForClients()).be.rejectedWith(InternalError);
    });

  });

  describe('Client', () => {
    var
      client;

    beforeEach(() => {
      server = new WSBrokerServer('internalBroker', kuzzle.config.internalBroker, kuzzle.pluginsManager);
      server.ws = (options, cb) => {
        cb();
        return new WSServerMock();
      };

      client = new WSBrokerClient('internalBroker', kuzzle.config.internalBroker, kuzzle.pluginsManager);
      client.ws = () => new WSClientMock(server.server);
    });

    describe('#constructor', () => { });

    describe('#init', () => {

      it('should attach events', () => {

        return server.init()
          .then(() => client.init())
          .then(response => {
            should(response).be.an.instanceOf(WSClientMock);
            should(client.client.state).be.exactly('connected');

            // callbacks initiated by the client
            should(client.client.socket.on.firstCall).be.calledWith('message');
            should(client.client.socket.on.secondCall).be.calledWith('open');
            should(client.client.socket.on.thirdCall).be.calledWith('close');
            should(client.client.socket.on.getCall(3)).be.calledWith('error');

            // callbacks initiated by the server
            should(client.client.socket.on.getCall(4)).be.calledWith('message');
            should(client.client.socket.on.getCall(5)).be.calledWith('close');
            should(client.client.socket.on.getCall(6)).be.calledWith('error');

            // triggers
            should(kuzzle.pluginsManager.trigger.callCount).be.exactly(1);
            should(kuzzle.pluginsManager.trigger.firstCall).be.calledWith('internalBroker:connected', 'Connected to Kuzzle server');
          });
      });

      it ('should return the current promise if already called', () => {
        var
          beforeInitOnCalls;

        return q.all([server.init(),client.init()])
          .then(() => {
            beforeInitOnCalls = client.client.socket.on.callCount;
            return client.init();
          })
          .then(() => should(client.client.socket.on.callCount).be.exactly(beforeInitOnCalls));
      });

      it('should wait for the broker server until the connection is established', (done) => {
        var state = '';

        sinon.spy(client, '_connect');
        
        // we init the client before the server.
        // The promise is resolved once the server is up and the connection is established
        // That means: there will be a timeout if the client is not able to retry the connection.
        client.init()
          .then(response => {
            should(response).be.an.instanceOf(WSClientMock);
            should(client.client.state).be.exactly('connected');
            should(state).be.exactly('retrying');
            should(client._connect.callCount).be.exactly(2);
            done();
          })
          .catch(err => done(err));
        
        server.init()
          .then(() => {
            state = client.client.state; // should be "retrying", as the client should have already tried to reach the server without success
            clock.tick(kuzzle.config.internalBroker.retryInterval); // should trigger a new client.init() call
          });
      });
    });

    describe('#listen & #unsubscribe', () => {
      beforeEach(() => q.all([server.init(),client.init()]));

      it ('should store the cb and send the request to the server', () => {
        var cb = sinon.stub();

        // listen
        client.listen('room', cb);

        should(client.handlers).be.eql({
          room: [cb]
        });
        should(client.client.socket.send).be.calledOnce();
        should(client.client.socket.send).be.calledWith(JSON.stringify({
          action: 'listen',
          room: 'room'
        }));

        // unsubscribe
        client.unsubscribe('room');

        should(client.handlers).be.eql({});
        should(client.client.socket.send).be.calledTwice();
        should(client.client.socket.send.secondCall.args[0]).be.eql(JSON.stringify({
          action: 'unsubscribe',
          room: 'room'
        }));
      });

      it('should do nothing if socket is null', () => {
        client.client.socket = null;

        should(client.unsubscribe('room')).be.eql(false);
        should(kuzzle.pluginsManager.trigger.callCount).be.eql(2);
      });
    });

    describe('#close', () => {
      beforeEach(() => q.all([server.init(),client.init()]));

      it('should close the socket', () => {
        var socket = client.client.socket;

        client.close();

        should(client.client.state).be.exactly('disconnected');
        should(socket.close).be.calledOnce();
        should(client.client.socket).be.null();
      });

      it('should do nothing if socket is null', () => {
        client.client.socket = null;

        should(client.close()).be.eql(false);
        should(kuzzle.pluginsManager.trigger.callCount).be.eql(2);
      });
    });

    describe('#send & broadcast', () => {
      beforeEach(() => q.all([server.init(),client.init()]));

      it('`send` should send properly envelopped data', () => {
        var
          data = {foo: 'bar'},
          socket = client.client.socket;

        client.send('room', data);

        should(socket.send).be.calledOnce();
        should(socket.send).be.calledWith(JSON.stringify({
          action: 'send',
          room: 'room',
          data: data
        }));
      });

      it('`broadcast` should send properly envelopped data', () => {
        var
          data = {foo: 'bar'},
          socket = client.client.socket;

        client.broadcast('room', data);

        should(socket.send).be.calledOnce();
        should(socket.send).be.calledWith(JSON.stringify({
          action: 'broadcast',
          room: 'room',
          data: data
        }));
      });
      
    });

    describe('#events', () => {
      beforeEach(() => {
        client.onConnectHandlers = [];
        client.onCloseHandlers = [];
        client.onErrorHandlers = [];
        
        return q.all([server.init(),client.init()]);
      });

      it('on open, should re-register if some callbacks were attached', () => {
        var
          newClient = new WSBrokerClient('internalBroker', kuzzle.config.internalBroker, kuzzle.pluginsManager),
          cb = sinon.stub();

        newClient.ws = () => new WSClientMock(server.server);
        newClient.handlers = {
          room: [ cb ]
        };
        newClient.onConnectHandlers = [sinon.spy()];

        return newClient.init()
          .then(() => {
            var socket = newClient.client.socket;

            should(socket.send).be.calledOnce();
            should(socket.send).be.calledWith(JSON.stringify({
              action: 'listen',
              room: 'room'
            }));
            should(newClient.onConnectHandlers[0]).be.calledOnce();
          });
      });
      
      it('on open, should trigger a warning if the client was already connected', () => {
        var 
          socket = client.client.socket;
        
        socket.emit('open', 1);
        
        should(client.pluginsManager.trigger).be.calledWith('log:warn', '[internalBroker] Node is connected while it was previously already.');
      });

      it('on close should do nothing if :close was explicitly called', () => {
        var socket = client.client.socket;

        client.client.state = 'disconnected';

        socket.emit('close', 1);

        should(client.client.socket).be.an.instanceOf(WSClientMock);
      });

      it('on close should not try to reconnect if explicitly asked so', () => {
        var socket = client.client.socket;

        client.reconnect = false;
        client.state = 'connected';
        client.retryTimer = 'something';

        socket.emit('close', 1);

        should(client.client.socket).be.null();
        should(client.retryTimer).be.null();
      });

      it('on close should try reconnecting if :close was not explicitly called', () => {
        var
          connectSpy = sandbox.spy(client, '_connect'),
          closeSpy = sandbox.spy(client, 'close'),
          socket = client.client.socket;
        
        client.onCloseHandlers.push(sinon.spy());

        // calling multiple times to check only one retry is issued
        socket.emit('close', 1);
        client.client.state = 'test';
        socket.emit('close', 1);
        client.client.state = 'test';
        socket.emit('close', 1);
        client.client.state = 'test';

        clock.tick(20000);
        
        should(socket.listeners.close[0]).have.callCount(3);
        should(closeSpy).have.callCount(3);
        should(connectSpy).be.calledOnce();
        should(client.onCloseHandlers[0]).be.calledThrice();
      });

      it('on error should set the client state to retrying and retry to connect', () => {
        var
          connectSpy = sandbox.spy(client, '_connect'),
          closeSpy = sandbox.spy(client, 'close'),
          socket = client.client.socket;
        
        client.onErrorHandlers.push(sinon.spy());

        socket.emit('error', new Error('test'));
        socket.emit('error', new Error('test'));
        socket.emit('error', new Error('test'));

        clock.tick(20000);
        
        should(socket.listeners.error[0]).be.have.callCount(3);
        should(closeSpy).be.have.callCount(3);
        should(client.client.state).be.exactly('retrying');
        should(connectSpy).be.calledOnce();
        should(client.onErrorHandlers[0]).be.calledThrice();
      });

      it('on error should not try to reconnect if asked so', () => {
        var socket = client.client.socket;
        
        client.reconnect = false;
        client.retryTimer = 'something';
        
        socket.emit('error', 1);
        
        should(client.client.socket).be.null();
        should(client.retryTimer).be.null();
      });
      
    });

  });

  describe('Server', () => {
    var client1, client2, client3;

    beforeEach(() => {
      /** @type InternalBroker */
      server = new WSBrokerServerRewire('internalBroker', {}, kuzzle.pluginsManager);
      server.ws = (options, cb) => {
        cb();
        return new WSServerMock();
      };
      server.onErrorHandlers = [];

      client1 = new WSBrokerClient('internalBroker', {}, kuzzle.pluginsManager);
      client2 = new WSBrokerClient('internalBroker', {}, kuzzle.pluginsManager);
      client3 = new WSBrokerClient('internalBroker', {}, kuzzle.pluginsManager);
      client1.ws = client2.ws = client3.ws = () => new WSClientMock(server.server);

      return q.all([
        server.init(),
        client1.init(),
        client2.init(),
        client3.init()
      ]);
    });
    
    describe('#init', () => {

      it('should reject the promise if already started', () => {
        return should(server.init()).be.rejectedWith(InternalError);
      });

      it('should attach some callbacks', () => {
        var socket = server.server;

        // 1st listener is injected in the mock to emit the 'open' event
        should(socket.on).be.calledThrice();
        should(socket.on.secondCall).be.calledWith('connection');
        should(socket.on.thirdCall).be.calledWith('error');
      });

    });

    describe('#broadcast', () => {

      it('should do nothing if the room is not defined', () => {
        should(server.broadcast('idontexist')).be.exactly(-1);
      });

      it('should send the message to all subscribers but the emitter', () => {
        var response;

        server.rooms = {
          test: new CircularList([
            client1.client.socket,
            client2.client.socket,
            client3.client.socket
          ])
        };

        response = server.broadcast('test', {foo: 'bar'}, client2.client.socket);

        should(response).be.exactly(2);
        should(client1.client.socket.listeners.message[0]).be.calledOnce();
        should(client1.client.socket.listeners.message[0]).be.calledWith(JSON.stringify({
          room: 'test',
          data: { foo: 'bar' }
        }));
        should(client3.client.socket.listeners.message[0]).be.calledOnce();
        should(client3.client.socket.listeners.message[0]).be.calledWith(JSON.stringify({
          room: 'test',
          data: { foo: 'bar' }
        }));
        should(client2.client.socket.listeners.message[0]).callCount(0);
      });

      it('should trigger the plugin manager if an error occured', () => {
        var
          response,
          error = new Error();

        server.rooms = {
          test: new CircularList([ client1.client.socket ])
        };
        client1.client.socket.send = sinon.stub().throws(error);

        response = server.broadcast('test', {foo: 'bar'}, client2.client.socket);

        should(response).be.exactly(0);
        should(kuzzle.pluginsManager.trigger.lastCall).be.calledWith('log:error', error);
      });

    });

    describe('#send', () => {

      it('should do nothing if the room does not exist', () => {
        return should(server.send('idontexist')).be.undefined();
      });

      it('should do nothing is the emitter is the only client', () => {
        var response;

        server.rooms = {
          test: new CircularList([ client1.client.socket ])
        };

        response = server.send('test', {foo: 'bar'}, client1.client.socket);

        should(response).be.undefined();
      });

      it('should send data to one of the other clients', () => {
        var response;

        server.rooms = {
          test: new CircularList([
            client1.client.socket,
            client2.client.socket,
            client3.client.socket
          ])
        };

        response = server.send('test', {foo: 'bar'}, client1.client.socket);

        should(response).be.exactly(client2.client.socket);
        should(client2.client.socket.send).be.calledOnce();
        should(client2.client.socket.send).be.calledWith(JSON.stringify({
          room: 'test',
          data: { foo: 'bar' }
        }));
        should(client2.client.socket.listeners.message[0]).be.calledOnce();
        should(client2.client.socket.listeners.message[0]).be.calledWith(JSON.stringify({
          room: 'test',
          data: { foo: 'bar' }
        }));

        should(client1.client.socket.send).callCount(0);
        should(client1.client.socket.listeners.message[0]).callCount(0);
        should(client3.client.socket.send).callCount(0);
        should(client3.client.socket.listeners.message[0]).callCount(0);
      });

    });

    describe('#dispatch', () => {

      it('should do nothing if the room does not exist', () => {
        should(server.dispatch('idontexist')).be.exactly(-1);
      });

      it('should call the handlers attached to the room', () => {
        var
          data = { foo: 'bar' },
          stub1 = sinon.stub(),
          stub2 = sinon.stub(),
          stub3 = sinon.stub(),
          stub4 = sinon.stub();

        server.handlers = {
          test1: [ stub1 ],
          test2: [ stub2, stub3 ],
          test3: [ stub4 ]
        };

        should(server.dispatch('test1', data)).be.exactly(1);
        should(stub1).be.calledOnce();
        should(stub1).be.calledWith(data);
        should(stub2).callCount(0);
        should(stub3).callCount(0);
        should(stub4).callCount(0);

        should(server.dispatch('test2', data)).be.exactly(2);
        should(stub2).be.calledOnce();
        should(stub2).be.calledWith(data);
        should(stub3).be.calledOnce();
        should(stub3).be.calledWith(data);
        should(stub4).callCount(0);
      });

    });

    describe('#listen', () => {

      it('should attach the given callback to the proper room', () => {
        var cb = {};

        server.listen('test', cb);

        should(server.handlers).be.eql({
          test: [cb]
        });
      });

    });

    describe('#waitForClients', () => {

      it('should return a fulfilled promise if some clients are already connected to the room', () => {
        server.rooms = { test: true };

        return should(server.waitForClients('test')).be.fulfilled();
      });

      it('should never resolve if no client connects', () => {
        var response = server.waitForClients('test');

        // wait 1h
        clock.tick(1000 * 3600);
        should(response.inspect().state).be.exactly('pending');
      });

      it('should resolve the promise once a client connects to the room', () => {
        var response = server.waitForClients('test');

        should(response.inspect().state).be.exactly('pending');

        server.rooms = { test: true };
        clock.tick(200);

        return should(response).be.fulfilled();
      });

    });

    describe('#unsubscribe', () => {

      it('should remove the events attached to a room', () => {
        server.handlers = {
          test: [ 1, 5 ],
          test2: [ 3 ]
        };

        server.unsubscribe('test');

        should(server.handlers).eql({
          test2: [3]
        });
      });

    });

    describe('#close', () => {

      it('should close the underlying socket', () => {
        var socket = server.server;

        server.close();

        should(server.server).be.null();
        should(socket.close).be.calledOnce();
      });

    });

    describe('#removeClient', () => {

      it('should close the client connection and clean up the rooms', () => {
        var
          clientSocket = new WSClientMock(server.server),
          removeClient = WSBrokerServerRewire.__get__('removeClient');

        server.rooms = {
          test: new CircularList([clientSocket])
        };

        removeClient.call(server, clientSocket);

        should(server.rooms).be.eql({ });
        should(server.rooms).be.empty();
      });

    });

    describe('#events', () => {

      it('client listen', () => {
        var
          serverSocket = server.server,
          clientSocket = new WSClientMock(serverSocket);

        serverSocket.emit('connection', clientSocket);

        clientSocket.emit('message', JSON.stringify({
          action: 'listen',
          room: 'test'
        }));

        should(server.rooms).be.eql({
          test: new CircularList([clientSocket])
        });
      });

      it('client unsubscribe', () => {
        var
          serverSocket = server.server,
          clientSocket = new WSClientMock(serverSocket);

        server.rooms = {
          test: new CircularList([ clientSocket ])
        };

        serverSocket.emit('connection', clientSocket);

        clientSocket.emit('message', JSON.stringify({
          action: 'unsubscribe',
          room: 'test'
        }));

        should(server.rooms).be.eql({});
      });

      it('client send', () => {
        var
          serverSocket = server.server,
          clientSocket = new WSClientMock(serverSocket),
          dispatchSpy = sandbox.spy(server, 'dispatch'),
          sendSpy = sandbox.spy(server, 'send');

        serverSocket.emit('connection', clientSocket);

        clientSocket.emit('message', JSON.stringify({
          action: 'send',
          room: 'test',
          data: {foo: 'bar'}
        }));

        should(dispatchSpy).be.calledOnce();
        should(dispatchSpy).be.calledWith('test', {foo: 'bar'});
        should(sendSpy).be.calledOnce();
        should(sendSpy).be.calledWith('test', {foo: 'bar'}, clientSocket);
      });

      it('client broadcast', () => {
        var
          serverSocket = server.server,
          clientSocket = new WSClientMock(serverSocket),
          dispatchSpy = sandbox.spy(server, 'dispatch'),
          broadcastSpy = sandbox.spy(server, 'broadcast');


        serverSocket.emit('connection', clientSocket);

        clientSocket.emit('message', JSON.stringify({
          action: 'broadcast',
          room: 'test',
          data: {foo: 'bar'}
        }));

        should(dispatchSpy).be.calledOnce();
        should(dispatchSpy).be.calledWith('test', {foo: 'bar'});
        should(broadcastSpy).be.calledOnce();
        should(broadcastSpy).be.calledWith('test', {foo: 'bar'}, clientSocket);
      });

      it('client close', () => {
        var
          serverSocket = server.server,
          clientSocket = new WSClientMock(serverSocket),
          removeClientSpy = sinon.spy();

        serverSocket.emit('connection', clientSocket);

        WSBrokerServerRewire.__with__('removeClient', removeClientSpy)(() => {
          clientSocket.emit('close', 1, 'test');

          should(removeClientSpy).be.calledOnce();
          should(removeClientSpy).be.calledWith(clientSocket);

          should(kuzzle.pluginsManager.trigger.lastCall).be.calledWith('log:info', 'client disconnected [1] test');
        });
      });

      it('server error', () => {
        var 
          serverSocket = server.server,
          error = new Error();
        
        server.onErrorHandlers.push(sinon.spy());
        
        serverSocket.emit('error', error);
        
        should(server.pluginsManager.trigger).have.callCount(4);
        should(server.pluginsManager.trigger.lastCall).be.calledWith('log:error');
        should(server.onErrorHandlers[0]).be.calledOnce();
      });
      
    });

  });
});

