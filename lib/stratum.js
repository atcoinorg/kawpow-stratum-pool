var BigNum = require('bignum');
var net = require('net');
var events = require('events');
var tls = require('tls');
var fs = require('fs');

var util = require('./util.js');

var TLSoptions;

var SubscriptionCounter = function () {
    var count = 0;
    var padding = 'deadbeefcafebabe';
    return {
        next: function () {
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
 **/
var StratumClient = function (options) {
    var pendingDifficulty = null;
    //private members
    this.socket = options.socket;
    this.remoteAddress = options.socket.remoteAddress;
    var banning = options.banning;
    var _this = this;
    this.lastActivity = Date.now();
    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function () {
        return false
    } : function (shareValid) {
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold) {
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init() {
        setupSocket();
    };

    function handleMessage(message) {
        // console.log("Received message: "+message);
        switch (message.method) {
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                sendJson({
                    id: null,
                    result: [],
                    error: true
                });
                break;
            case 'mining.extranonce.subscribe':
                sendJson({
                    id: message.id,
                    result: false,
                    error: [20, "Not supported.", null]
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubscribe(message) {
        if (!_this.authorized) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.emit('subscription',
            {},
            function (error, extraNonce1, extraNonce1) {
                if (error) {
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;

                sendJson({
                    id: message.id,
                    result: [
                        null, //sessionId
                        extraNonce1
                    ],
                    error: null
                });
            });
    }

    function getSafeString(s) {
        return s.toString().replace(/[^a-zA-Z0-9._]+/g, '');
    }

    function getSafeWorkerString(raw) {
        var s = getSafeString(raw).split(".");
        var addr = s[0];
        var wname = "noname";
        if (s.length > 1)
            wname = s[1];
        return addr + "." + wname;
    }

    function handleAuthorize(message) {
        // console.log("Handing authorize");

        _this.workerName = getSafeWorkerString(message.params[0]);
        _this.workerPass = message.params[1];

        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, _this.extraNonce1, _this.version, function (result) {
            _this.authorized = (!result.error && result.authorized);

            sendJson({
                id: message.id,
                result: _this.authorized,
                error: result.error
            });

            _this.emit('authorization');

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    function handleSubmit(message) {
        if (_this.authorized === false) {
            sendJson({
                id: message.id,
                result: null,
                error: [24, "unauthorized worker", null]
            });
            considerBan(false);
            return;
        }
        if (!_this.extraNonce1) {
            sendJson({
                id: message.id,
                result: null,
                error: [25, "not subscribed", null]
            });
            considerBan(false);
            return;
        }

        _this.emit('submit',
            {
                name: message.params[0],
                jobId: message.params[1],
                nonce: message.params[2].substr(2),
                header: message.params[3].substr(2),
                mixhash: message.params[4].substr(2)
            },
            function (error, result) {
                // if (!considerBan(result)){
                sendJson({
                    id: message.id,
                    result: result,
                    error: error
                });
                // }
            }
        );

    }

    function sendJson() {
        var response = '';
        for (var i = 0; i < arguments.length; i++) {
            response += JSON.stringify(arguments[i]) + '\n';
        }
        console.log("sendJson (>>>): " + response);
        options.socket.write(response);
    }

    function setupSocket() {
        // console.log("Setup socket");
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                } else {
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        } else {
            _this.emit('checkBan');
        }
        socket.on('data', function (d) {
            dataBuffer += d;
            if (new Buffer.byteLength(dataBuffer, 'utf8') > 10240) { //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function (message) {
                    if (message.length < 1) return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch (e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }

                        return;
                    }
                    if (messageJson) {
                        console.log("handleMessage (<<<): " + JSON.stringify(messageJson));
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function () {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function (err) {
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function () {
        return (_this.workerName || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
    };

    this.enqueueNextDifficulty = function (requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function (difficulty) {
        if (difficulty === this.difficulty)
            return false;
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;

        //powLimit * difficulty
        var powLimit = algos.kawpow.diff; // TODO: Get algos object from argument
        var adjPow = powLimit / difficulty;
        if ((64 - adjPow.toString(16).length) === 0) {
            var zeroPad = '';
        } else {
            var zeroPad = '0';
            zeroPad = zeroPad.repeat((64 - (adjPow.toString(16).length)));
        }
        var target = (zeroPad + adjPow.toString(16)).substr(0, 64);


        sendJson({
            id: null,
            method: "mining.set_target",
            params: [target]
        });

        return true;
    };

    this.sendMiningJob = function (jobParams) {

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.socket.destroy();
            return;
        }

        if (pendingDifficulty !== null) {
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }

        //change target to miners' personal varDiff target
        var personal_jobParams = jobParams;
        var powLimit = algos.kawpow.diff;
        var adjPow = powLimit / _this.difficulty;
        if ((64 - adjPow.toString(16).length) === 0) {
            var zeroPad = '';
        } else {
            var zeroPad = '0';
            zeroPad = zeroPad.repeat((64 - (adjPow.toString(16).length)));
        }
        personal_jobParams[3] = (zeroPad + adjPow.toString(16)).substr(0, 64);

        sendJson({
            id: null,
            method: "mining.notify",
            params: personal_jobParams
        });

    };

    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1 = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty = otherClient.difficulty;
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;


/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn) {

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter();
    var rebroadcastTimeout;
    var bannedIPs = {};

    function checkBan(client) {
        if (options.banning && options.banning.enabled && client.remoteAddress in bannedIPs) {
            var bannedTime = bannedIPs[client.remoteAddress];
            var bannedTimeAgo = Date.now() - bannedTime;
            var timeLeft = bannedMS - bannedTimeAgo;
            if (timeLeft > 0) {
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            } else {
                delete bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }
        }
    }

    this.handleNewClient = function (socket) {

        // console.log("Handling new client");

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                coin: options.coin,
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout,
                tcpProxyProtocol: options.tcpProxyProtocol
            }
        );

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function () {
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', function () {
            checkBan(client);
        }).on('triggerBan', function () {
            _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function (jobParams) {
        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function () {
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };


    (function init() {

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled) {
            setInterval(function () {
                for (ip in bannedIPs) {
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval);
        }

        var serversStarted = 0;
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].tls) {
                // console.log("TLS port for "+port);
                tls.createServer(TLSoptions, function (socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function () {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            } else {
                // console.log("TCP port for "+port);
                net.createServer({allowHalfOpen: false}, function (socket) {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), function () {
                    serversStarted++;
                    if (serversStarted == Object.keys(options.ports).length)
                        _this.emit('started');
                });
            }
        });
    })();


    //public members

    this.addBannedIP = function (ipAddress) {
        bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function (clientObj) {
        var subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
