var
  q = require('q');

/**
 * @param {Kuzzle} kuzzle
 * @param {Object} responseQueue
 * @constructor
 */
function WorkerListener (kuzzle, responseQueue) {
  this.waitingQueries = {};

  startListener.call(this, kuzzle, responseQueue);

  /**
   * Asks the listener to watch for a specific response coming from workers.
   * Only worker-eligible tasks are waited for, since other tasks transmit their response directly
   * Any response received without this function called beforehand will be discarded
   *
   * @param requestObject the query object that will generate a response from Kuzzle
   */
  this.add = function (requestObject) {
    var deferred = q.defer();

    this.waitingQueries[requestObject.requestId] = deferred;

    return deferred.promise;
  };
}

/**
 * Starts a listener dedicated to workers responses.
 * Discards keys added by the worker to sync with the server from the response.
 *
 * @this WorkerListener
 * @param kuzzle
 * @param responseQueue name of the queue to listen to
 */
function startListener(kuzzle, responseQueue) {
  kuzzle.services.list.broker.listen(responseQueue, serializedResponse => {
    var
      requestId = serializedResponse.requestId;
    
    delete serializedResponse.requestId;

    if (requestId && this.waitingQueries[requestId]) {
      if (!serializedResponse.status || serializedResponse.status !== 200) {
        this.waitingQueries[requestId].reject(serializedResponse);
      }
      else {
        delete serializedResponse.status;
        this.waitingQueries[requestId].resolve(serializedResponse);
      }

      delete this.waitingQueries[requestId];
    }
    else {
      kuzzle.pluginsManager.trigger('log:verbose', 'Discarded response in queue ' + responseQueue + ': ' + serializedResponse);
    }
  });
}

module.exports = WorkerListener;
