var
  q = require('q'),
  should = require('should'),
  params = require('rc')('kuzzle'),
  rewire = require('rewire'),
  sinon = require('sinon'),
  Kuzzle = require.main.require('lib/api/Kuzzle'),
  Services = rewire('../../lib/services'),
  sandbox = sinon.sandbox.create();

describe('Test service initialization function', function () {

  var
    clock,
    kuzzle;
  
  before(() => {
    clock = sinon.useFakeTimers(Date.now());
  });
  
  after(() => {
    clock.restore();
  });

  beforeEach(() => {
    kuzzle = new Kuzzle();
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        kuzzle.removeAllListeners();
        kuzzle.internalEngine.client.transport = {};
      });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should build an internal broker service with correct methods', function () {
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        should(kuzzle.services.list.broker).be.an.Object().and.not.be.empty();
        should(kuzzle.services.list.broker.init).be.a.Function();
        should(kuzzle.services.list.broker.send).be.a.Function();
        should(kuzzle.services.list.broker.broadcast).be.a.Function();
        should(kuzzle.services.list.broker.listen).be.a.Function();
        should(kuzzle.services.list.broker.unsubscribe).be.a.Function();
        should(kuzzle.services.list.broker.close).be.a.Function();
      });
  });

  it('should build a MQ broker service with correct methods', function () {
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        should(kuzzle.services.list.mqBroker).be.an.Object().and.not.be.empty();
        should(kuzzle.services.list.mqBroker.init).be.a.Function();
        should(kuzzle.services.list.mqBroker.toggle).be.a.Function();
        should(kuzzle.services.list.mqBroker.add).be.a.Function();
        should(kuzzle.services.list.mqBroker.addExchange).be.a.Function();
        should(kuzzle.services.list.mqBroker.listenExchange).be.a.Function();
        should(kuzzle.services.list.mqBroker.replyTo).be.a.Function();
        should(kuzzle.services.list.mqBroker.listen).be.a.Function();
        should(kuzzle.services.list.mqBroker.listenOnce).be.a.Function();
        should(kuzzle.services.list.mqBroker.close).be.a.Function();
      });
  });
  
  it('should build a readEngine service with correct methods', function () {
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        should(kuzzle.services.list.readEngine).be.an.Object();
        should(kuzzle.services.list.readEngine.init).be.a.Function();
        should(kuzzle.services.list.readEngine.search).be.a.Function();
        should(kuzzle.services.list.readEngine.get).be.a.Function();
      });
  });

  it('should build a writeEngine service with correct methods', function () {
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        should(kuzzle.services.list.writeEngine).be.an.Object();
        should(kuzzle.services.list.writeEngine.init).be.a.Function();
        should(kuzzle.services.list.writeEngine.create).be.a.Function();
        should(kuzzle.services.list.writeEngine.update).be.a.Function();
        should(kuzzle.services.list.writeEngine.deleteByQuery).be.a.Function();
        should(kuzzle.services.list.writeEngine.import).be.a.Function();
      });
  });

  it('should build a cache service', function () {
    return kuzzle.start(params, {dummy: true})
      .then(() => {
        should(kuzzle.services.list.notificationCache).be.an.Object();
        should(kuzzle.services.list.notificationCache.add).be.a.Function();
        should(kuzzle.services.list.notificationCache.remove).be.a.Function();
        should(kuzzle.services.list.notificationCache.search).be.a.Function();
      });
  });

  it('should not init services in blacklist', function () {
    var spy = sandbox.stub(kuzzle.internalEngine, 'get').resolves({});

    kuzzle.config = {
      default: {
        services: {
          initTimeout: 10000
        }
      },
      services: {
        writeEngine: 'elasticsearch'
      }
    };

    return kuzzle.services.init({blacklist: ['writeEngine']})
      .then(() => {
        should(kuzzle.services.list.writeEngine.client).be.null();
        should(spy.calledOnce).be.true();
      });
  });
  
  it('should propagate the internalEngine rejections', () => {
    var 
      error = new Error();
    
    sandbox.stub(kuzzle.internalEngine, 'get').rejects(error);
    
    kuzzle.config = {
      default: {services: {initTimeout: 1000}},
      services: {myService: 'foo'}
    };
    
    return should(kuzzle.services.init())
      .be.rejectedWith(error);
  });
  
  describe('#registerService', () => {
    var 
      registerService = Services.__get__('registerService'),
      scope;
    
    beforeEach(() => {
      scope = {
        kuzzle: {
          config: {
            default: {services: {initTimeout: 10000 }},
            services: { }
          },
          pluginsManager: {
            trigger: sinon.spy()
          }
        },
        list: {}

      };
    });
    
    it('should throw an error if the service file doesn\'t exist', () => {
      scope.kuzzle.config.services = { writeEngine: 'foo' };
      
      should(() => registerService.call(scope, 'writeEngine', {}))
        .throw('File services/foo.js not found to initialize service writeEngine');
      
      should(scope.kuzzle.pluginsManager.trigger).be.calledOnce();
      should(scope.kuzzle.pluginsManager.trigger).be.calledWith('log:error',
        'File services/foo.js not found to initialize service writeEngine');
    });

    it('should reject the promise if the service did not init in time', () => {
      scope.kuzzle.config.services.myService = 'foo';
      
      // we need to mock require in the function's scope module.
      return Services.__with__({
        require: () => function () {
          this.init = () => q.defer().promise;
        }
      })(() => {
        var r = registerService.call(scope, 'myService', { timeout: 1000 }, true);
        clock.tick(1000);
        
        return should(r).be.rejectedWith('[FATAL] Service "myService" failed to init within 1000ms');
      });
    });
    
    it('should reject the promise with the error received from the service', () => {
      var 
        myError = new Error('test');
      
      scope.kuzzle.config.services.myService = 'foo';

      // we need to mock require in the function's scope module.
      return Services.__with__({
        require: () => function () {
          this.init = () => q.reject(myError);
        }
      })(() => {
        return should(registerService.call(scope, 'myService', {}, true))
          .be.rejectedWith(myError);
      });
      
    });
    
  });

  
});
