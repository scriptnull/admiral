'use strict';

var self = initialize;
module.exports = self;

var async = require('async');
var _ = require('underscore');
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;

var APIAdapter = require('../../common/APIAdapter.js');
var configHandler = require('../../common/configHandler.js');

function initialize(req, res) {
  var bag = {
    resBody: [],
    res: res,
    apiAdapter: new APIAdapter(req.headers.authorization.split(' ')[1]),
    params: {},
    skipStatusChange: false,
    isResponseSent: false,
    systemIntegration: null,
    component: 'msg',
    tmpScript: '/tmp/msg.sh'
  };

  bag.who = util.format('msg|%s', self.name);
  logger.info(bag.who, 'Starting');

  async.series([
      _checkInputParams.bind(null, bag),
      _get.bind(null, bag),
      _checkConfig.bind(null, bag),
      _setProcessingFlag.bind(null, bag),
      _sendResponse.bind(null, bag),
      _getReleaseVersion.bind(null, bag),
      _generateInitializeEnvs.bind(null, bag),
      _generateInitializeScript.bind(null, bag),
      _writeScriptToFile.bind(null, bag),
      _initializeMsg.bind(null, bag),
      _getSystemIntegration.bind(null, bag),
      _putSystemIntegration.bind(null, bag),
      _postSystemIntegration.bind(null, bag),
      _checkCredentials.bind(null, bag),
      _post.bind(null, bag)
    ],
    function (err) {
      logger.info(bag.who, 'Completed');
      if (!bag.skipStatusChange)
        _setCompleteStatus(bag, err);

      if (err) {
        // only send a response if we haven't already
        if (!bag.isResponseSent)
          respondWithError(bag.res, err);
        else
          logger.warn(err);
      }
      //TODO: remove tmp file
    }
  );
}

function _checkInputParams(bag, next) {
  var who = bag.who + '|' + _checkInputParams.name;
  logger.verbose(who, 'Inside');

  return next();
}

function _get(bag, next) {
  var who = bag.who + '|' + _get.name;
  logger.verbose(who, 'Inside');

  configHandler.get(bag.component,
    function (err, msg) {
      if (err) {
        bag.skipStatusChange = true;
        return next(
          new ActErr(who, ActErr.DataNotFound,
            'Failed to get ' + bag.component, err)
        );
      }

      if (_.isEmpty(msg)) {
        bag.skipStatusChange = true;
        return next(
          new ActErr(who, ActErr.DataNotFound,
            'No configuration in database for ' + bag.component)
        );
      }

      bag.config = msg;
      return next();
    }
  );
}

function _checkConfig(bag, next) {
  /* jshint maxcomplexity:20 */
  var who = bag.who + '|' + _checkConfig.name;
  logger.verbose(who, 'Inside');

  var missingConfigFields = [];

  if (!_.has(bag.config, 'username') || _.isEmpty(bag.config.username))
    missingConfigFields.push('username');
  if (!_.has(bag.config, 'password') || _.isEmpty(bag.config.password))
    missingConfigFields.push('password');
  if (!_.has(bag.config, 'uiUsername') || _.isEmpty(bag.config.uiUsername))
    missingConfigFields.push('uiUsername');
  if (!_.has(bag.config, 'uiPassword') || _.isEmpty(bag.config.uiPassword))
    missingConfigFields.push('uiPassword');
  if (!_.has(bag.config, 'address') || _.isEmpty(bag.config.address))
    missingConfigFields.push('address');
  if (!_.has(bag.config, 'amqpPort') || !bag.config.amqpPort)
    missingConfigFields.push('amqpPort');
  if (!_.has(bag.config, 'adminPort') || !bag.config.adminPort)
    missingConfigFields.push('adminPort');

  if (missingConfigFields.length)
    return next(
      new ActErr(who, ActErr.DataNotFound,
        'Missing config data: ' + missingConfigFields.join())
    );

  return next();
}

function _setProcessingFlag(bag, next) {
  var who = bag.who + '|' + _setProcessingFlag.name;
  logger.verbose(who, 'Inside');

  var update = {
    isProcessing: true,
    isFailed: false
  };

  configHandler.put(bag.component, update,
    function (err) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to update config for ' + bag.component, err)
        );

      return next();
    }
  );
}

function _sendResponse(bag, next) {
  var who = bag.who + '|' + _sendResponse.name;
  logger.verbose(who, 'Inside');

  // We reply early so the request won't time out while
  // waiting for the service to start.

  sendJSONResponse(bag.res, bag.resBody, 202);
  bag.isResponseSent = true;
  return next();
}

function _getReleaseVersion(bag, next) {
  var who = bag.who + '|' + _getReleaseVersion.name;
  logger.verbose(who, 'Inside');

  var query = '';
  bag.apiAdapter.getSystemSettings(query,
    function (err, systemSettings) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to get system settings : ' + util.inspect(err))
        );

      bag.releaseVersion = systemSettings.releaseVersion;

      return next();
    }
  );
}

function _generateInitializeEnvs(bag, next) {
  if (!bag.config.isShippableManaged) return next();

  var who = bag.who + '|' + _generateInitializeEnvs.name;
  logger.verbose(who, 'Inside');

  bag.scriptEnvs = {
    'RUNTIME_DIR': global.config.runtimeDir,
    'CONFIG_DIR': global.config.configDir,
    'RELEASE': bag.releaseVersion,
    'SSH_USER': global.config.sshUser,
    'SSH_PRIVATE_KEY': path.join(global.config.configDir, 'machinekey'),
    'SSH_PUBLIC_KEY': path.join(global.config.configDir, 'machinekey.pub'),
    'MSG_HOST': bag.config.address,
    'SCRIPTS_DIR': global.config.scriptsDir,
    'IS_INITIALIZED': bag.config.isInitialized,
    'IS_INSTALLED': bag.config.isInstalled,
    'ADMIRAL_IP': global.config.admiralIP,
    'MSG_UI_USER': bag.config.uiUsername,
    'MSG_UI_PASS': bag.config.uiPassword,
    'MSG_USER': bag.config.username,
    'MSG_PASS': bag.config.password,
    'AMQP_PORT': bag.config.amqpPort,
    'ADMIN_PORT': bag.config.adminPort,
    'RABBITMQ_ADMIN':
      path.join(global.config.scriptsDir, '/rabbitmqadmin')
  };

  return next();
}

function _generateInitializeScript(bag, next) {
  if (!bag.config.isShippableManaged) return next();

  var who = bag.who + '|' + _generateInitializeScript.name;
  logger.verbose(who, 'Inside');

  //attach header
  var filePath = path.join(global.config.scriptsDir, '/lib/_logger.sh');
  var headerScript = '';
  headerScript = headerScript.concat(__applyTemplate(filePath, bag.params));

  var helpers = headerScript;
  filePath = path.join(global.config.scriptsDir, '/lib/_helpers.sh');
  helpers = headerScript.concat(__applyTemplate(filePath, bag.params));

  var initializeScript = helpers;
  filePath = path.join(global.config.scriptsDir, 'installMsg.sh');
  initializeScript =
    initializeScript.concat(__applyTemplate(filePath, bag.params));

  bag.script = initializeScript;
  return next();
}

function _writeScriptToFile(bag, next) {
  if (!bag.config.isShippableManaged) return next();

  var who = bag.who + '|' + _writeScriptToFile.name;
  logger.debug(who, 'Inside');

  fs.writeFile(bag.tmpScript,
    bag.script,
    function (err) {
      if (err) {
        var msg = util.format('%s, Failed with err:%s', who, err);
        return next(
          new ActErr(
            who, ActErr.OperationFailed, msg)
        );
      }
      fs.chmodSync(bag.tmpScript, '755');
      return next();
    }
  );
}


function _initializeMsg(bag, next) {
  if (!bag.config.isShippableManaged) return next();

  var who = bag.who + '|' + _initializeMsg.name;
  logger.verbose(who, 'Inside');

  var exec = spawn('/bin/bash',
    ['-c', bag.tmpScript],
    {
      env: bag.scriptEnvs
    }
  );

  exec.stdout.on('data',
    function (data)  {
      console.log(data.toString());
    }
  );

  exec.stderr.on('data',
    function (data)  {
      console.log(data.toString());
    }
  );

  exec.on('close',
    function (exitCode)  {
      if (exitCode > 0)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Script returned code: ' + exitCode)
        );
      return next();
    }
  );
}

function _getSystemIntegration(bag, next) {
  var who = bag.who + '|' + _getSystemIntegration.name;
  logger.verbose(who, 'Inside');

  bag.apiAdapter.getSystemIntegrations('name=msg&masterName=rabbitmqCreds',
    function (err, systemIntegrations) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to get system integration: ' + util.inspect(err))
        );

      if (!_.isEmpty(systemIntegrations))
        bag.systemIntegration = systemIntegrations[0];

      return next();
    }
  );
}

function _putSystemIntegration(bag, next) {
  if (!bag.systemIntegration) return next();

  var who = bag.who + '|' + _putSystemIntegration.name;
  logger.verbose(who, 'Inside');

  var putObject = {
    name: 'msg',
    masterName: 'rabbitmqCreds',
    data: _generateSystemIntegrationData(bag)
  };

  bag.apiAdapter.putSystemIntegration(bag.systemIntegration.id, putObject,
    function (err, systemIntegration) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to update system integration: ' + util.inspect(err))
        );

      bag.systemIntegration = systemIntegration;
      return next();
    }
  );
}

function _postSystemIntegration(bag, next) {
  if (bag.systemIntegration) return next();

  var who = bag.who + '|' + _postSystemIntegration.name;
  logger.verbose(who, 'Inside');

  var postObject = {
    name: 'msg',
    masterName: 'rabbitmqCreds',
    data: _generateSystemIntegrationData(bag)
  };

  bag.apiAdapter.postSystemIntegration(postObject,
    function (err) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to create system integration: ' + util.inspect(err))
        );

      return next();
    }
  );
}

function _generateSystemIntegrationData(bag) {
  var amqpAddress = (bag.config.isSecure ? 'amqps://' : 'amqp://') +
    bag.config.username + ':' + bag.config.password +
    '@' + bag.config.address + ':' + bag.config.amqpPort;
  var httpAddress = (bag.config.isSecure ? 'https://' : 'http://') +
    bag.config.username + ':' + bag.config.password +
    '@' + bag.config.address + ':' + bag.config.adminPort;

  var data = {
    amqpUrl: amqpAddress + '/shippable',
    amqpUrlRoot: amqpAddress + '/shippableRoot',
    amqpUrlAdmin: httpAddress,
    amqpDefaultExchange: 'shippableEx',
    rootQueueList: 'core.charon|versions.trigger|core.nf|nf.email|' +
      'nf.hipchat|nf.irc|nf.slack|nf.webhook|core.braintree|core.certgen|' +
      'core.hubspotSync|core.marshaller|marshaller.ec2|core.sync|' +
      'job.request|job.trigger|cluster.init|steps.deploy|steps.manifest|' +
      'steps.provision|steps.rSync|steps.release|core.logup|www.signals|' +
      'core.segment'
  };

  return data;
}

function _checkCredentials(bag, next) {
  if (bag.config.isShippableManaged) return next();

  var who = bag.who + '|' + _checkCredentials.name;
  logger.verbose(who, 'Inside');

  bag.apiAdapter.getMsgStatus(
    function (err, status) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to check RabbitMQ credentials: ' + util.inspect(err))
        );

      if (status.error)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Invalid RabbitMQ credentials: ' + status.error)
        );

      return next();
    }
  );
}

function _post(bag, next) {
  var who = bag.who + '|' + _post.name;
  logger.verbose(who, 'Inside');

  var update = {
    isInstalled: true,
    isInitialized: true
  };

  configHandler.put(bag.component, update,
    function (err) {
      if (err)
        return next(
          new ActErr(who, ActErr.OperationFailed,
            'Failed to update config for ' + bag.component, err)
        );

      return next();
    }
  );
}

function _setCompleteStatus(bag, err) {
  var who = bag.who + '|' + _setCompleteStatus.name;
  logger.verbose(who, 'Inside');

  var update = {
    isProcessing: false
  };
  if (err)
    update.isFailed = true;
  else
    update.isFailed = false;

  configHandler.put(bag.component, update,
    function (err) {
      if (err)
        logger.warn(err);
    }
  );
}

//local function to apply vars to template
function __applyTemplate(filePath, dataObj) {
  var fileContent = fs.readFileSync(filePath).toString();
  var template = _.template(fileContent);

  return template({obj: dataObj});
}
