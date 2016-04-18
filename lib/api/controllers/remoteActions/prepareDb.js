var
  fs = require('fs'),
  RequestObject = require('../../core/models/requestObject.js'),
  ResponseObject = require('../../core/models/responseObject'),
  InternalError = require('../../core/errors/internalError'),
  async = require('async'),
  q = require('q'),
  rc = require('rc');

module.exports = function PrepareDb (kuzzle, request) {
  var
    deferred = q.defer(),
    response;

  this.kuzzle = kuzzle;

  if (this.kuzzle.isServer) {

    this.data = {};
    this.params = rc('kuzzle');
    this.files = {
      fixtures: null,
      mappings: null
    };

    if (request.data.body.fixtures) {
      this.files.fixtures = request.data.body.fixtures;
    }
    if (request.data.body.mappings) {
      this.files.mappings = request.data.body.mappings;
    }

    this.defaultRoleDefinition = this.params.roleWithoutAdmin;

    this.kuzzle.pluginsManager.trigger('log:info', '== Starting DB preparation...');
    createInternalStructure.call(this)
      .then(() => {
        return readFile.call(this, 'mappings');
      })
      .then(() => {
        return readFile.call(this, 'fixtures');
      })
      .then(() => {
        return createIndexes.call(this);
      })
      .then(() => {
        return importMapping.call(this);
      })
      .then(() => {
        return importFixtures.call(this);
      })
      .then(() => {
        this.kuzzle.pluginsManager.trigger('log:info', '== DB preparation done.');
        return deferred.resolve(new ResponseObject(request));
      })
      .catch(error => {
        this.kuzzle.pluginsManager.trigger('log:error', '!! An error occured during the process.\nHere is the original error object:\n', error);
        return deferred.resolve(new ResponseObject(request, new InternalError(error)));
      });
  } else {
    response = new ResponseObject(request);
    response.data.body = { isWorker: true };
    deferred.resolve(response);
    return deferred.promise;
  }

  return deferred.promise;
};

function createInternalStructure() {
  var requestObject = new RequestObject({controller: 'admin', action: 'createIndex', index: this.kuzzle.config.internalIndex});

  if (this.kuzzle.indexCache.indexes[this.kuzzle.config.internalIndex]) {
    return q(new ResponseObject(requestObject));
  }

  this.kuzzle.pluginsManager.trigger('log:info', '== Creating Kuzzle internal index...');

  this.kuzzle.pluginsManager.trigger('data:createIndex', requestObject);

  return this.kuzzle.workerListener.add(requestObject)
    .then(() => {
      this.kuzzle.indexCache.add(this.kuzzle.config.internalIndex);

      this.kuzzle.pluginsManager.trigger('log:info', '== Creating roles collection...');

      requestObject = new RequestObject({
        controller: 'admin',
        action: 'updateMapping',
        index: this.kuzzle.config.internalIndex,
        collection: 'roles',
        body: {
          properties: {
            indexes: {
              enabled: false
            }
          }
        }
      });

      this.kuzzle.pluginsManager.trigger('data:updateMapping', requestObject);
      return this.kuzzle.workerListener.add(requestObject);
    })
    .then(() => {
      this.kuzzle.indexCache.add(this.kuzzle.config.internalIndex, 'roles');

      this.kuzzle.pluginsManager.trigger('log:info', '== Creating profiles collection...');

      requestObject = new RequestObject({
        controller: 'admin',
        action: 'updateMapping',
        index: this.kuzzle.config.internalIndex,
        collection: 'profiles',
        body: {
          properties: {
            roles: {
              index: 'not_analyzed',
              type: 'string'
            }
          }
        }
      });

      this.kuzzle.pluginsManager.trigger('data:updateMapping', requestObject);
      return this.kuzzle.workerListener.add(requestObject);
    })
    .then(() => {
      this.kuzzle.indexCache.add(this.kuzzle.config.internalIndex, 'profiles');
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating users collection...');

      requestObject = new RequestObject({
        controller: 'admin',
        action: 'updateMapping',
        index: this.kuzzle.config.internalIndex,
        collection: 'users',
        body: {
          properties: {
            profile: {
              index: 'not_analyzed',
              type: 'string'
            },
            password: {
              index: 'no',
              type: 'string'
            }
          }
        }
      });

      this.kuzzle.pluginsManager.trigger('data:updateMapping', requestObject);
      return this.kuzzle.workerListener.add(requestObject);
    })
    .then(() => {
      this.kuzzle.indexCache.add(this.kuzzle.config.internalIndex, 'users');
    })
    .then(() => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default role for anonymous...');

      this.defaultRoleDefinition._id = 'anonymous';

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceRole',
        body: this.defaultRoleDefinition
      });


      return this.kuzzle.funnel.controllers.security.createOrReplaceRole(requestObject, {});
    })
    .then(() => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default role for default...');

      this.defaultRoleDefinition._id = 'default';

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceRole',
        body: this.defaultRoleDefinition
      });

      return this.kuzzle.funnel.controllers.security.createOrReplaceRole(requestObject, {});
    })
    .then(() => {
      this.kuzzle.indexCache.add(this.kuzzle.config.internalIndex, 'roles');
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default role for admin...');

      this.defaultRoleDefinition._id = 'admin';

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceRole',
        body: this.defaultRoleDefinition
      });


      return this.kuzzle.funnel.controllers.security.createOrReplaceRole(requestObject, {});
    })

    .then(() => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default profile for default...');

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceProfile',
        body: {_id: 'default', roles: [ 'default' ]}
      });


      return this.kuzzle.funnel.controllers.security.createOrReplaceProfile(requestObject, {});
    })
    .then(() => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default profile for anonymous...');

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceProfile',
        body: {_id: 'anonymous', roles: [ 'anonymous' ]}
      });

      return this.kuzzle.funnel.controllers.security.createOrReplaceProfile(requestObject, {});
    })
    .then(() => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Creating default profile for admin...');

      requestObject = new RequestObject({
        controller: 'security',
        action: 'createOrReplaceProfile',
        body: {_id: 'admin', roles: [ 'admin' ]}
      });

      return this.kuzzle.funnel.controllers.security.createOrReplaceProfile(requestObject, {});
    });

}

function readFile(which) {
  var 
    deferred = q.defer();

  if (!this.files[which] || this.files[which] === '') {
    this.kuzzle.pluginsManager.trigger('log:info', '== No default ' + which + ' file specified in env vars: continue.');
    this.data[which] = {};
    deferred.resolve();
    return deferred.promise;
  }

  this.kuzzle.pluginsManager.trigger('log:info', '== Reading default ' + which + ' file ' + this.files[which] + '...');

  try {
    this.data[which] = JSON.parse(fs.readFileSync(this.files[which], 'utf8'));
    this.kuzzle.pluginsManager.trigger('log:info', '== Reading default ' + which + ' file ' + this.files[which] + ' done.');
    deferred.resolve();
  }
  catch (e) {
    this.kuzzle.pluginsManager.trigger('log:info',
      'An error occured when reading the ' + which + ' file located at' + this.files[which] + '! \n' +
      'Remember to put the file into the docker scope...\n' +
      'Here is the original error: ' + e
    );

    this.kuzzle.pluginsManager.trigger('preparedb:error', 'Error while loading the file ' + this.files[which]);
    deferred.reject(new ResponseObject(new RequestObject({controller: 'admin', action: 'prepareDb'}), new InternalError('Error while loading the file ' + this.files[which])));
  }
  return deferred.promise;
}

function createIndexes() {
  var deferred = q.defer();

  async.map(
    Object.keys(this.data.mappings).concat(Object.keys(this.data.fixtures)),
    (index, callback) => {
      var requestObject = new RequestObject({controller: 'admin', action: 'createIndex', index: index});

      if (this.kuzzle.indexCache.indexes[index]) {
        callback(null, true);

      } else {
        this.kuzzle.pluginsManager.trigger('data:createIndex', requestObject);

        this.kuzzle.workerListener.add(requestObject)
          .then(() => {
            this.kuzzle.pluginsManager.trigger('log:info', '== index "' + index + '" created.');
            this.kuzzle.indexCache.add(index);
            callback(null, true);
          })
          .catch((error) => {
            this.kuzzle.pluginsManager.trigger('log:error', '!! index "' + index + '" not created: ' + JSON.stringify(error));
            callback(error);
          });
      }

    }, 
    (error) => {
      this.kuzzle.pluginsManager.trigger('log:info', '== Index creation process terminated.');

      if (error) {
        this.kuzzle.pluginsManager.trigger('preparedb:error',
          '!! An error occured during the indexes creation.\nHere is the original error message:\n'+error.message
        );

        deferred.reject(new InternalError('An error occured during the indexes creation.\nHere is the original error message:\n'+error.message));
        return deferred.promise;
      }

      return deferred.resolve();
    }
  );

  return deferred.promise;
}

function importMapping() {
  var
    deferred = q.defer();

  async.each(Object.keys(this.data.mappings), (index, callbackIndex) => {
    async.each(Object.keys(this.data.mappings[index]), (collection, callbackCollection) => {
      var
        requestObject,
        msg;

      if (!this.data.mappings[index][collection].properties) {
        msg = '== Invalid mapping detected: missing required "properties" field';
        this.kuzzle.pluginsManager.trigger('log:err', msg);
        return callbackCollection(msg);
      }

      this.kuzzle.pluginsManager.trigger('log:info', '== Importing mapping for ' + index + ':' + collection + '...');

      requestObject = new RequestObject({
        controller: 'admin',
        action: 'updateMapping',
        index: index,
        collection: collection,
        body: this.data.mappings[index][collection]
      });

      this.kuzzle.pluginsManager.trigger('data:updateMapping', requestObject);
      this.kuzzle.workerListener.add(requestObject)
        .then(() => callbackCollection())
        .catch(response => callbackCollection('Mapping import error' + response.error.message));
    }, error => callbackIndex(error));
  }, error => {
    if (error) {
      this.kuzzle.pluginsManager.trigger('log:error', 'An error occured during the mappings import.\nHere is the original error object:\n', error);
      return deferred.reject(new InternalError(error));
    }

    this.kuzzle.pluginsManager.trigger('log:info', '== All mapping imports launched.');
    return deferred.resolve();

  });

  return deferred.promise;
}

function importFixtures() {
  var
    deferred = q.defer();

  async.each(Object.keys(this.data.fixtures), (index, callbackIndex) => {
    async.each(Object.keys(this.data.fixtures[index]), (collection, callback) => {
      var
        fixture = {
          controller: 'bulk',
          action: 'import',
          index: index,
          collection: collection,
          body: this.data.fixtures[index][collection]
        },
        requestObject = new RequestObject(fixture);

      this.kuzzle.pluginsManager.trigger('log:info', '== Importing fixtures for collection ' + index + ':' + collection + '...');

      this.kuzzle.pluginsManager.trigger('data:bulkImport', requestObject);

      this.kuzzle.workerListener.add(requestObject)
        .then(() => callback())
        .catch(response => {
          // 206 = partial errors
          if (response.status !== 206) {
            return callback(response.error.message);
          }

          // We need to filter "Document already exists" errors
          if (response.error.errors.filter(e => { return e.status !== 409; }).length === 0) {
            callback();
          } else {
            callback(response.error.message);
          }
        });
    }, function (error) {
      callbackIndex(error);
    });
  }, error => {
    if (error) {
      this.kuzzle.pluginsManager.trigger('log:error', '== Fixture import error: ' + error.message);
      return deferred.reject(new InternalError(error));
    }

    this.kuzzle.pluginsManager.trigger('log:info', '== All fixtures imports launched.');
    return deferred.resolve();
  });

  return deferred.promise;
}