var IrcSocket = require('irc-socket'),
	IrcMessage = require('irc-message').parseMessage,
	EventEmitter2 = require('eventemitter2').EventEmitter2,
	codes = require(__dirname + '/codes'),
	QueuePool = require(__dirname + '/queuepool').QueuePool,
	ListCache = require(__dirname + '/listcache').ListCache,
	_ = require('lodash');
// include all our required libraries

var Events = new EventEmitter2({
	wildcard: true,
	newListener: false,
	maxListeners: 0
});
// we create an event emitter here, but only one, and use it for every irc client we initiate
// that way we don't have 2 event emitters for each client and use an insane amount of memory
// when we scale up to hundreds of clients, we use namespaces for individual clients

// ========================================
// These functions don't need to be in the Client namespace anymore
// it's just wasting memory when we have a lot of clients, they can be
// in a helper.

var Helper = {
	// Features supported by the server
	// (initial values are RFC 1459 defaults. Zeros signify no default or unlimited value)
	defaultSupported: function() {
		return {
			network: {
				name: '',
				hostname: '',
				ircd: '',
				nicklength: 9,
				maxtargets: {}
			},
			channel: {
				idlength: {},
				limit: {},
				length: 200,
				modes: 0,
				types: '#&',
				kicklength: 0,
				topiclength: 0
			},
			modes: {
				user: '',
				channel: '',
				param: '',
				types: {
					a: '',
					b: '',
					c: '',
					d: ''
				},
				prefixes: '~&@%+',
				prefixmodes: {
					q: '~',
					a: '&',
					o: '@',
					h: '%',
					v: '+'
				},
				maxlist: {}
			},
			raw: []
		};
	},

	parse: function(line) {
		var message = IrcMessage(line);

		if (message === null) {
			return false;
		}

		if (message.prefixIsHostmask()) {
			var hostmask = message.parseHostmaskFromPrefix();
			message.nickname = hostmask.nickname;
			message.username = hostmask.username;
			message.hostname = hostmask.hostname;
		} else {
			message.server = message.prefix;
		}

		if (codes[message.command]) {
			message.command = codes[message.command];
		}

		message.raw = line;
		// apply the raw line aswell

		return message;
	},

	time: function(enabled, message) {
		if (!message || !message.tags || message.tags.length === 0) {
			return new Date();
		}
		// no time, return a normal date object from now

		var enabled = _.intersection(['server-time', 'znc.in/server-time', 'znc.in/server-time-iso']);
		
		if (enabled.length > 0) {
			var time = message.tags.time || null;
			// we have a time capability enabled, lets try find the tag

			if (time === null) {
				return new Date();
				// tags.time doesn't exist, strange, never mind just return a new date object
			} else if (typeof time === 'string') {
				if (time.indexOf('T') > -1) {
					return new Date(time);
				} else {
					return new Date(int(time) * 1000);
				}
			} else if (typeof time === 'number') {
				return new Date(time * 1000);
			}
			// lets do some checks to see what format it is
		}
		
		return new Date();
		// we've got this far so we have a time, let's check if we have any time capabilities enabled
	},

	col: function(finalstr) {
		if (finalstr.indexOf('^') === -1) { 
			return finalstr;
		}

		var colourcodes = finalstr.match(/\\*\^[0-9]{1}[0-5]?,[0-9]{1}[0-5]?|\^((20|1([0-9]?)|[0-9])|[0-9])/g);
		// if message contains a colour trigger
		
		for (var i in colourcodes) {
			if (colourcodes[i][0] == '\\') { 
				finalstr = finalstr.replace(colourcodes[i], colourcodes[i].slice(1));
				break;
			}

			var num = colourcodes[i].slice(1).split(',');
			// divide it into foreground and background
			
			if (num.length === 1) {
				if (num[0] > 15) {
					switch(num[0]) {
						case '16':
							finalstr = finalstr.replace(colourcodes[i], '\x02');
							break;
							// bold
						case '17':
							finalstr = finalstr.replace(colourcodes[i], '\x09');
							break;
							// italic 
						case '18':
							finalstr = finalstr.replace(colourcodes[i], '\x13');
							break;
							// strike-through
						case '19':
							finalstr = finalstr.replace(colourcodes[i], '\x15');
							break;
							// underline
						case '20':
							finalstr = finalstr.replace(colourcodes[i], '\x0f');
							break;
							// reset
						default:
							break;
					}
					// if this trigger is not a colour
				} else {
					finalstr = finalstr.replace(colourcodes[i], '\x03' + num[0]);
					// otherwise it's a colour
				}
			} else {
				var background = num[1],
					foreground = num[2];
				
				finalstr = finalstr.replace(colourcodes[i], '\x03' + num[0] + ',' + num[1]);
			}
			// if background colour
		}

		return finalstr;
	}
};
// ========================================

function Client(key, options, GenericSocket) {
	var self = this,
		genericSocket = GenericSocket || undefined;
	
	self.connection = IrcSocket(options, genericSocket);
	self.options = options;
	self.supported = Helper.defaultSupported();
	self.key = key;

	self._queueId = QueuePool.queueLength(options.server);
	self._nick = options.nick;
	self._hostname = options.hostname;
	self._user = options.user;
	self._oper = false;
	self._requestedDisconnect = false;
	self._sendRegisteredTimer;
	self._pings = 0;
	self._retryTimer = null;
	self._retryCount = 0;
	self._capCount = 0;
	self._nickModifier = 0;
	self._cap = {};
	self._data = {
		user: {},
		channel: {},
		server: {}
	};
	// setup a bunch of variables to manage the state of the connection

	self.queueConnect = _.wrap(self.connection.connect, function(fn, qid) {
		QueuePool.queueJob(self.options.server, qid, self.key, fn.bind(self.connection));
	});
	// setup queueConnect

	self.connection.setTimeout(100000, function() {});
	// set a soft timeout of 100s - it takes 3 calls to be certain that we're gone
	// so no activity within 300 seconds we'll disconnect the socket and start to try again

	self.queueConnect(self._queueId);
	// connect the server

	self.connection.on('connect', self._connectEvent.bind(self));
	self.connection.on('timeout', self._timeoutEvent.bind(self));
	self.connection.on('close', self._closeEvent.bind(self));
	self.connection.on('error', function(err) { });
	self.connection.on('data', self._parseLine.bind(self));
	// event handlers
};

// ========================================
// Setup an irc events object, using this over a switch, seems much cleaner
// the huge switch was something I hated about node-irc.

Client.prototype._parseLine = function (line) {
	var message = Helper.parse(line);

	if (!message) {
		return false;
	}
	// irc-message found a bad line

	if (_.isFunction(this._ircEvents[message.command])) {
		this._ircEvents[message.command].call(this, message);
	} else {
		delete message.tags;
		message.time = Helper.time(this._cap.enabled, message);
		Events.emit([this.key, 'unknown'], message);
	}
	// we were using a switch here but it's a bit grim
	// so we're storing the numerics as functions in _ircEvents and
	// calling the nessicary event
};

Client.prototype._ircEvents = {
	CAP: function(message) {
		var capabilities = message.params[2].trim().replace(/(?:^| )[\-~=]/, '').split(' '),
			enable = ['away-notify', 'multi-prefix', 'server-time', 'znc.in/server-time-iso', 'znc.in/server-time'];
		// which capabilities should we try to enable, for now just away notify, until others are supported

		if (this.options.sasl && this.options.password !== null) {
			// we check for sasl AND password, so we can let users put passwords in without
			// connecting via sasl, such as genuinely passworded ircds
			enable.push('sasl');
		}

		switch(message.params[1]) {
			case 'LS':
				this._cap = {};
				// reset the object, if we just store it in this, we might end up with repeat values on a reconnect

				this._cap.requested = _.intersection(capabilities, enable);
				// we need to figure out if we can enable any of the capabilities the server supports

				if (this._cap.requested.length == 0) {
					this.raw(['CAP', 'END']);
					this._cap.handshake = false;
				} else {
					this.raw(['CAP', 'REQ', this._cap.requested.join(' ')]);
					this._cap.handshake = true;
				}
				// here the server is going to tell us what capabilities it supports
				break;
			case 'ACK':
				if (capabilities.length > 0) {
					this._cap.enabled = capabilities;
					// these are the capabilities that are enabled
					this._cap.requested = _.difference(this._cap.requested, capabilities);
				}

				if (this._cap.enabled.length > 0) {
					if (_.contains(this._cap.enabled, 'sasl')) {
						this._cap.sasl = true;
						this.raw(['AUTHENTICATE', 'PLAIN']);
						// we need to figure out if this is SASL, if not
						// we're done and can close the handshake, below;
					} else {
						this.raw(['CAP', 'END']);
						this._cap.handshake = false;
					}
				}
				break;
			case 'NAK':
				if (capabilities.length > 0) {
					this._cap.requested = _.difference(this._cap.requested, capabilities);
				}
				
				if (this._cap.requested.length > 0) {
					this.raw(['CAP', 'END']);
					this._cap.handshake = false;
				}
				// we've been denied the request, lets end.			
				break;
		}
	},
	
	AUTHENTICATE: function(message) {
		if (message.params[0] == '+') {
			var username = this.options.saslUsername || this._nick,
				password = this.options.password,
				tmp = new Buffer(username + '\0' + username + '\0' + password).toString('base64');
			// encode the base64 hash to send to the server

			this.raw(['AUTHENTICATE', tmp]);
			// we've got the go ahead to attempt to authenticate.
			// at the request of Techman (y) I've implemented the ability to sasl auth via
			// a different username unlike basically every client out there
			// we do this with this.options.saslUsername, if it's not present just use nickname
		} else {
			this.raw(['CAP', 'END']);
			this._cap.handshake = false;
			this._cap.sasl = false;
		}
	},

	RPL_YOUREOPER: function(message) {
		this._oper = true;
	},

	RPL_NOTOPERANYMORE: function(message) {
		this._oper = false;
	},

	RPL_SASLAUTHENTICATED: function(message) {
		this.raw(['CAP', 'END']);
		this._cap.handshake = false;
		this._cap.sasl = true;
	},

	RPL_SASLLOGGEDIN: function(message) {
		if (!this._cap.handshake) {
			this.raw(['CAP', 'END']);
		}
	},

	ERR_SASLNOTAUTHORISED: function(message) {
		this.raw(['CAP', 'END']);
		this._cap.handshake = false;
	},

	AWAY: function(message) {
		if (message.params.length !== 0 && message.params[0] !== '') {
			Events.emit([this.key, 'away'], {
				nickname: message.nickname,
				username: message.username,
				hostname: message.hostname,
				message: message.params[0],
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		} else {
			Events.emit([this.key, 'unaway'], {
				nickname: message.nickname,
				username: message.username,
				hostname: message.hostname,
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		}
	},

	ERR_NICKNAMEINUSE: function(message) {
		this._nickModifier++;
		var nickname = this._nick + this._nickModifier.toString();
		// create a new nickname

		this.nick(nickname);
	},

	ERR_NOMOTD: function(message) {
		var target = message.params[0];

		this._addData('server', target, 'motd', [message.params[1]]);
		this._addData('server', target, 'raw', [message.raw]);

		Events.emit([this.key, 'motd'], this._getData('server', target, message));
		this._clearData('server', target);
	},

	RPL_WELCOME: function(message) {
		this.supported = Helper.defaultSupported();
		this._negotiation = true;
		this._pings = 0;
		this._requestedDisconnect = false;
		this._nick = message.params[0];
		// reset variables

		this.supported.raw.push(message.raw);

		clearTimeout(this._sendRegisteredTimer);
		this._sendRegisteredTimer = setTimeout(this._sendRegistered.bind(this, message), 10);
	},

	RPL_YOURHOST: function(message) {
		this.supported.raw.push(message.raw);

		clearTimeout(this._sendRegisteredTimer);
		this._sendRegisteredTimer = setTimeout(this._sendRegistered.bind(this, message), 10);
	},

	RPL_CREATED: function(message) {
		this.supported.raw.push(message.raw);

		clearTimeout(this._sendRegisteredTimer);
		this._sendRegisteredTimer = setTimeout(this._sendRegistered.bind(this, message), 10);
	},

	RPL_MYINFO: function(message) {
		this.supported.network.hostname = message.params[1];
		this.supported.network.ircd = message.params[2]
		this.supported.modes.user = message.params[3];
		this.supported.modes.channel = message.params[4];
		this.supported.modes.param = message.params[5];
		this.supported.raw.push(message.raw);

		clearTimeout(this._sendRegisteredTimer);
		this._sendRegisteredTimer = setTimeout(this._sendRegistered.bind(this, message), 10);
	},

	RPL_ISUPPORT: function(message) {
		for (var argi in message.params) {
			var arg = message.params[argi],
				match;

			if (match = arg.match(/([A-Z]+)=(.*)/)) {
				var param = match[1],
					value = match[2];

				if (param == 'NETWORK') {
					this.supported.network.name = value;
				} else if (param == 'NICKLEN') {
					this.supported.network.nicklength = parseInt(value);
				} else if (param == 'TARGMAX') {
					var values = value.split(',');
					for (var vali in values) {
						var val = values[vali].split(':');
						val[1] = (!val[1]) ? 0 : parseInt(val[1]);
						this.supported.network.maxtargets[val[0]] = val[1];
					}
				} else if (param == 'IDCHAN') {
					var values = value.split(',');
					for (var vali in values) {
						var val = values[vali].split(':');
						this.supported.channel.idlength[val[0]] = val[1];
					}
				} else if (param == 'CHANLIMIT') {
					var values = value.split(',');
					for (var vali in values) {
						var val = values[vali].split(':');
						this.supported.channel.limit[val[0]] = parseInt(val[1]);
					}
				} else if (param == 'CHANNELLEN') {
					this.supported.channel.length = parseInt(value);
				} else if (param == 'MODES') {
					this.supported.channel.modes = parseInt(value);
				} else if (param == 'CHANTYPES') {
					this.supported.channel.types = value;
				} else if (param == 'KICKLEN') {
					this.supported.channel.kicklength = parseInt(value);
				} else if (param == 'TOPICLEN') {
					this.supported.channel.topiclength = parseInt(value);
				} else if (param == 'CHANMODES') {
					value = value.split(',');
					var type = ['a', 'b', 'c', 'd'];
					for (var i = 0; i < type.length; i++) {
						this.supported.modes.types[type[i]] += value[i];
					}
				} else if (param == 'PREFIX') {
					if (match = value.match(/\((.*?)\)(.*)/)) {
						match[1] = match[1].split('');
						match[2] = match[2].split('');
						
						this.supported.modes.prefixes = '';
						this.supported.modes.prefixmodes = {};
						// overwrite the default if we've got a PREFIX

						while (match[1].length) {
							this.supported.modes.types.b += match[1][0];
							this.supported.modes.prefixes += match[2][0];
							this.supported.modes.prefixmodes[match[1].shift()] = match[2].shift();
						}
					}
				} else if (param == 'MAXLIST') {
					var values = value.split(',');
					for (var vali in values) {
						var val = values[vali].split(':');
						this.supported.modes.maxlist[val[0]] = parseInt(val[1]);
					}
				}
			}
		}

		this.supported.raw.push(message.raw);
		// append the raw lines

		clearTimeout(this._sendRegisteredTimer);
		this._sendRegisteredTimer = setTimeout(this._sendRegistered.bind(this, message), 10);
	},

	RPL_LUSERCLIENT: function(message) {
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_LUSEROP: function(message) {
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_LUSERUNKNOWN: function(message) {
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_LUSERME: function(message) {
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_STATSCONN: function(message) {
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_LUSERCHANNELS: function(message) {
		var target = message.params[0];

		this._addData('server', target, 'channels', message.params[1]);
		this._addData('server', target, 'raw', [message.raw]);
	},

	RPL_LOCALUSERS: function(message) {
		var target = message.params[0];

		this._addData('server', target, 'local', message.params[1]);
		this._addData('server', target, 'localmax', message.params[2]);
		this._addData('server', target, 'raw', [message.raw]);
	},

	RPL_GLOBALUSERS: function(message) {
		var target = message.params[0];

		this._addData('server', target, 'global', message.params[1]);
		this._addData('server', target, 'globalmax', message.params[2]);
		this._addData('server', target, 'raw', [message.raw]);

		Events.emit([this.key, 'lusers'], this._getData('server', target, message));
		this._clearData('server', target);
	},

	RPL_ENDOFMOTD: function(message) {
		var target = message.params[0];

		this._addData('server', target, 'motd', [message.params[1]]);
		this._addData('server', target, 'raw', [message.raw]);

		Events.emit([this.key, 'motd'], this._getData('server', target, message));
		this._clearData('server', target);

	},

	RPL_MOTDSTART: function(message) {
		this._addData('server', message.params[0], 'motd', [message.params[1]]);
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_MOTD: function(message) {
		this._addData('server', message.params[0], 'motd', [message.params[1]]);
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_HOSTHIDDEN: function(message) {
		this._hostname = message.params[1];
	},

	RPL_NAMREPLY: function(message) {
		var target = message.params[2].toLowerCase();
		
		this._addData('channel', target, 'names', _.without(message.params[3].split(/ +/), ''));
		this._addData('channel', target, 'raw', [message.raw]);
	},

	RPL_ENDOFNAMES: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('channel', target, 'raw', [message.raw]);

		Events.emit([this.key, 'names'], this._getData('channel', target, message));
		this._clearData('channel', target);
	},

	RPL_AWAY: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'away', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},

	RPL_WHOISUSER: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'nickname', message.params[1]);
		this._addData('user', target, 'username', message.params[2]);
		this._addData('user', target, 'hostname', message.params[3]);
		this._addData('user', target, 'realname', message.params[5]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISIDLE: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'idle', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISCHANNELS: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'channels', _.without(message.params[2].trim().split(/ +/), ''));
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISSERVER: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'server', message.params[2]);
		this._addData('user', target, 'serverinfo', message.params[3]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISMODES: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'modes', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISHOST: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'host', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISADMIN: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'operator', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISOPERATOR: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'operator', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISHELPOP: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'helpop', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISBOT: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'bot', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISSPECIAL: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'special', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISACCOUNT: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'account', message.params[2]);
		this._addData('user', target, 'accountinfo', message.params[3]);
		this._addData('user', target, 'raw', [message.raw]);
	},

	RPL_WHOISLOGGEDIN: function(message) {
		var target = message.params[1].toLowerCase();
		
		this._addData('user', target, 'loggedin', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_WHOISSECURE: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('user', target, 'secure', message.params[2]);
		this._addData('user', target, 'raw', [message.raw]);
	},
	
	RPL_ENDOFWHOIS: function(message) {
		var target = message.params[1].toLowerCase();

		Events.emit([this.key, 'whois'], this._getData('user', target, message));
		this._clearData('user', target);
	},

	RPL_WHOREPLY: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('channel', target, 'who', [{
			channel: target,
			prefix: message.params[2] + '@' + message.params[3],
			nickname: message.params[5],
			mode: message.params[6],
			extra: message.params[7] || ''
		}]);
		this._addData('channel', target, 'raw', [message.raw]);
	},

	RPL_ENDOFWHO: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('channel', target, 'raw', [message.raw]);

		Events.emit([this.key, 'who'], this._getData('channel', target, message));
		this._clearData('channel', target);
	},

	RPL_LISTSTART: function(message) {
		ListCache.createList(this);
	},

	RPL_LIST: function(message) {
		ListCache.insertListData(this, message);
	},

	RPL_LISTEND: function(message) {
		Events.emit([this.key, 'listend'], {});
	},

	RPL_LINKS: function(message) {
		this._addData('server', message.params[0], 'links', [{
			server: message.params[1],
			link: message.params[2],
			description: message.params[3]
		}]);
		this._addData('server', message.params[0], 'raw', [message.raw]);
	},

	RPL_ENDOFLINKS: function(message) {
		var target = message.params[0];

		Events.emit([this.key, 'links'], this._getData('server', target, message));
		this._clearData('server', target);
	},

	RPL_BANLIST: function(message) {
		var channel = message.params[1].toLowerCase();

		this._addData('channel', channel, 'banlist', [{
			channel: channel,
			setby: message.params[3],
			hostname: message.params[2],
			timestamp: message.params[4]
		}]);

		this._addData('channel', channel, 'raw', [message.raw]);
	},

	RPL_ENDOFBANLIST: function(message) {
		var target = message.params[1].toLowerCase(),
			results = this._getData('channel', target, message);

		if (results) {
			Events.emit([this.key, 'banlist'], results);
		} else {
			Events.emit([this.key, 'banlist'], {
				channel: target,
				banlist: [],
				raw: message.raw,
				time: Helper.time(this._cap.enabled, message)
			});
		}
		
		this._clearData('channel', target);
	},

	RPL_INVITELIST: function(message) {
		var channel = message.params[1].toLowerCase();

		this._addData('channel', channel, 'invitelist', [{
			channel: channel,
			setby: message.params[3],
			hostname: message.params[2],
			timestamp: message.params[4]
		}]);

		this._addData('channel', channel, 'raw', [message.raw]);
	},

	RPL_ENDOFINVITELIST: function(message) {
		var target = message.params[1].toLowerCase(),
			results = this._getData('channel', target, message);

		if (results) {
			Events.emit([this.key, 'invitelist'], results);
		} else {
			Events.emit([this.key, 'invitelist'], {
				channel: target,
				invitelist: [],
				raw: message.raw,
				time: Helper.time(this._cap.enabled, message)
			});
		}

		this._clearData('channel', target);
	},

	RPL_EXCEPTLIST: function(message) {
		var channel = message.params[1].toLowerCase();

		this._addData('channel', channel, 'exceptlist', [{
			channel: channel,
			setby: message.params[3],
			hostname: message.params[2],
			timestamp: message.params[4]
		}]);

		this._addData('channel', channel, 'raw', [message.raw]);
	},

	RPL_ENDOFEXCEPTLIST: function(message) {
		var target = message.params[1].toLowerCase(),
			results = this._getData('channel', target, message);

		if (results) {
			Events.emit([this.key, 'exceptlist'], results);
		} else {
			Events.emit([this.key, 'exceptlist'], {
				channel: target,
				exceptlist: [],
				raw: message.raw,
				time: Helper.time(this._cap.enabled, message)
			});
		}

		this._clearData('channel', target);
	},

	RPL_QUIETLIST: function(message) {
		var channel = message.params[1].toLowerCase();

		this._addData('channel', channel, 'quietlist', [{
			channel: channel,
			setby: message.params[3],
			hostname: message.params[2],
			timestamp: message.params[4]
		}]);

		this._addData('channel', channel, 'raw', [message.raw]);
	},

	RPL_ENDOFQUIETLIST: function(message) {
		var target = message.params[1].toLowerCase(),
			results = this._getData('channel', target, message);

		if (results) {
			Events.emit([this.key, 'quietlist'], results);
		} else {
			Events.emit([this.key, 'quietlist'], {
				channel: target,
				quietlist: [],
				raw: message.raw,
				time: Helper.time(this._cap.enabled, message)
			});
		}

		this._clearData('channel', target);
	},

	RPL_TOPICWHOTIME: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('channel', target, 'topicBy', message.params[2]);
		this._addData('channel', target, 'raw', [message.raw]);
		// set topic by, all the other stuff such as topic should be here aswell

		Events.emit([this.key, 'topic'], this._getData('channel', target, message));
		this._clearData('channel', target);
		// emit it and clear, we dont output directly cause we need to get properties from earlier
	},

	RPL_TOPIC: function(message) {
		var target = message.params[1].toLowerCase();

		this._addData('channel', target, 'topic', message.params[2]);
		this._addData('channel', target, 'raw', [message.raw]);
		// set the topic from RPL, usually on JOIN or TOPIC
		// we use _addChannelData because we need to store it temporarily between commands :3
	},

	RPL_NOTOPIC: function(message) {
		Events.emit([this.key, 'topic'], {
			channel: message.params[0],
			topic: '',
			topicBy: '',
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	TOPIC: function(message) {
		Events.emit([this.key, 'topic_change'], {
			channel: message.params[0],
			topic: message.params[1],
			topicBy: message.nickname + '!' + message.username + '@' + message.hostname,
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	RPL_CHANNELMODEIS: function(message) {
		Events.emit([this.key, 'mode'], {
			channel: message.params[1],
			mode: message.params.slice(2).join(' '),
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	MODE: function(message) {
		var target = message.params[0],
			mode = message.params.slice(1).join(' ');

		if (target == this._nick || target == this.options.nick) {
			Events.emit([this.key, 'usermode'], {
				nickname: target,
				mode: mode,
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		} else {
			Events.emit([this.key, 'mode_change'], {
				nickname: message.nickname,
				username: message.username,
				hostname: message.hostname,
				channel: target,
				mode: mode,
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});

			this._clearData('channel', target);
		}
	},

	NICK: function(message) {
		if (message.nickname === this._nick) {
			this._nick = message.params[0];
		}
		// we've changed our own nick, update our internal record

		Events.emit([this.key, 'nick'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			newnick: message.params[0],
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	JOIN: function(message) {
		if (message.nickname === this._nick) {
			this._hostname = message.hostname;
		}
		// update our internal record

		Events.emit([this.key, 'join'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			channel: message.params[0],
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
		// our node-irc implementation did shit like, checking for netsplits
		// i'm not going to add this at the moment, cause it was touchy
	},

	PART: function(message) {
		Events.emit([this.key, 'part'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			channel: message.params[0],
			message: message.params[1] || '',
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	KICK: function(message) {
		Events.emit([this.key, 'kick'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			kicked: message.params[1],
			channel: message.params[0],
			message: message.params[2] || '',
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	QUIT: function(message) {
		Events.emit([this.key, 'quit'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			message: message.params[0] || '',
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	INVITE: function(message) {
		Events.emit([this.key, 'invite'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			channel: message.params[1],
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
	},

	NOTICE: function(message) {
		if (message.params.length < 2) {
			return false;
		}
		// safeguard against nonsense messages

		var to = message.params[0],
			text = message.params[1];

		if (((text[0] === '+' && text[1] === '\1') || text[0] === '\1') && text.lastIndexOf('\1') > 0) {
			this._handleCTCP(message, text, 'NOTICE');
		} else {
			Events.emit([this.key, 'notice'], {
				nickname: message.nickname,
				username: message.username,
				hostname: message.hostname,
				target: message.params[0],
				message: message.params[1],
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		}
		// ctcp response or normal notice?
	},

	PRIVMSG: function(message) {
		if (message.params.length < 2) {
			return false;
		}
		// safeguard against nonsense messages

		var to = message.params[0],
			text = message.params[1];

		if (((text[0] === '+' && text[1] === '\1') || text[0] === '\1') && text.lastIndexOf('\1') > 0) {
			this._handleCTCP(message, text, 'PRIVMSG');
		} else {
			Events.emit([this.key, 'privmsg'], {
				nickname: message.nickname,
				username: message.username,
				hostname: message.hostname,
				target: message.params[0],
				message: message.params[1],
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		}
		// ctcp or normal message?
		// the + infront of it xchat was sending? Not sure why, but we accomodate for that now.
	},

	PONG: function(message) {
		this._pings--;
	},

	ERROR: function(message) {
		if (/(.*)(throttled|throttling)(.*)/i.test(message.params[0])) {
			Events.emit([this.key, 'throttled'], {
				message: message.params[1],
				time: Helper.time(this._cap.enabled, message),
				raw: message.raw
			});
		}
	}
};

Client.prototype.raw = function(data) {
	for (var index in data) {
		var token = data[index];
		if (token.indexOf('\n') !== -1 || token.indexOf('\r') !== -1) {
			data[index] = token.replace('\n', '').replace('\r', '');
		}
	}

	if (_.isArray(data) || _.isString(data)) {
		this.connection.raw(data);
	} else {
		this.connection.raw(_.values(arguments));
	}
};

Client.prototype.nick = function(newnick) {
	this.raw(['NICK', newnick]);
};

Client.prototype.join = function(channel, password) {
	var password = password || '';
	this.raw(['JOIN', channel, password]);
};

Client.prototype.part = function(channel, message) {
	var message = message || '';
	this.raw(['PART', channel, message]);
};

Client.prototype.mode = function() {
	var target = arguments[0],
		mode = Array.prototype.slice.call(arguments, 1);

	this.raw(['MODE', target].concat(mode));
};

Client.prototype.topic = function(channel, topic) {
	var topic = topic || '';
	this.raw(['TOPIC', channel, Helper.col(topic)]);
};

Client.prototype.notice = function(target, message, forcePushBack) {
	var forcePushBack = forcePushBack || false,
		msg = Helper.col(message);
	
	this.raw(['NOTICE', target, msg]);

	if (forcePushBack) {
		this._parseLine(':' + this._nick + '!' + this._user + '@' + this._hostname + ' NOTICE ' + target + ' :' + msg);
	}
};

Client.prototype.privmsg = function(target, message, forcePushBack) {
	forcePushBack = forcePushBack || false;
	var rawPrefix = 'PRIVMSG ' + target + ' :',
		cutOff = 510 - rawPrefix.length;

	var cutAndSend = function (msgStr) {
		var buf = (new Buffer(cutOff)).write(msgStr, 0, 'utf8');
		var charLen = Buffer._charsWritten;

		if (charLen < msgStr.length) {

			// split the message
			var head = msgStr.substr(0, charLen);
			var tail = msgStr.substr(charLen);

			// try to respect word boundaries
			var lastWordIndex = head.lastIndexOf(" ");
			if (lastWordIndex > 0) {
				tail = head.substr(lastWordIndex) + tail;
				head = head.substr(0, lastWordIndex);
			}

			// send along
			send(head.trim());
			// and recurse
			cutAndSend(tail.trim());
		} else {
			send(msgStr);
		}
	};

	/* NOTE:
	 * forcePushBack is undocumented, and it's to be used to send the final formatted string back
	 * to the client who sent it, because we don't actually get reciepts for outgoing PRIVMSGs
	 * most clients fake it or insert it manually into their views. We provide the option to push it
	 * back into _parseLine so that any client listening for PRIVMSGs will treat it like it's incoming
	 * and not outgoing. This is in use in the ircanywhere repository for outgoing messages
	 */
	var send = function (msg) {
		this.raw(['PRIVMSG', target, msg]);

		if (forcePushBack) {
			this._parseLine(':' + this._nick + '!' + this._user + '@' + this._hostname + ' PRIVMSG ' + target + ' :' + msg);
		}

	}.bind(this);

	cutAndSend(Helper.col(message));
};

Client.prototype.me = function(target, message, forcePushBack) {
	var forcePushBack = forcePushBack || false,
		msg = '\x01ACTION ' + Helper.col(message) + '\x01';

	this.raw(['PRIVMSG', target, msg]);

	if (forcePushBack) {
		this._parseLine(':' + this._nick + '!' + this._user + '@' + this._hostname + ' PRIVMSG ' + target + ' :' + msg);
	}
};

Client.prototype.ctcp = function(target, type, text, forcePushBack) {
	var forcePushBack = forcePushBack || false,
		msg = '\x01' + type.toUpperCase() + ' ' + Helper.col(text) + '\x01';

	this.raw(['NOTICE', target, msg]);

	if (forcePushBack) {
		this._parseLine(':' + this._nick + '!' + this._user + '@' + this._hostname + ' NOTICE ' + target + ' :' + msg);
	}
};

Client.prototype.list = function(search, page, limit) {
	var search = search || '*',
		page = page || 1,
		limit = limit || 50;
	// defaults

	search = search.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
	regex = search.replace(/\\\*/g, '(.*)');
	// convert '*php*' into regex '(.*)php(.*)'

	ListCache.requestList(this, regex, page, limit);
};

Client.prototype.disconnect = function(message) {
	this._requestedDisconnect = true;

	if (this.connection.isConnected()) {
		this.raw(['QUIT', message || 'Disconnecting']);
		// are we still event connected? if so send QUIT
	}

	if (this._pings > 1) {
		this.connection.end();
		this._closeEvent();
		// looks like we've timed out, destroy the connection and emit a close event
	}
};

Client.prototype.reconnect = function() {
	if (this.connection.isConnected()) {
		this.disconnect();
	}
	// disconnect if connected

	this._nick = this.options.nick;

	this._nickModifier = 0;
	this._cap = {};
	this._data = {
		user: {},
		channel: {},
		server: {}
	};

	this.queueConnect(this._queueId);
	// connect the server
};

Client.prototype.isConnected = function() {
	return this.connection.isConnected();
};
// ========================================

// ========================================
// the following 3 functions are based on the ones from
// node-irc

Client.prototype._addData = function(type, name, key, value) {
	if (!type || !name || !key || !value) {
		return false;
	}
	// safe guarding parameters

	if (type == 'user') {
		var obj = {nickname: name};
	} else if (type == 'channel') {
		var obj = {channel: name};
	} else {
		var obj = {};
	}
	// create a default object template

	name = name.toLowerCase();

	this._data[type][name] = this._data[type][name] || obj;

	if (key in this._data[type][name] && Array.isArray(this._data[type][name][key]))
		this._data[type][name][key].push.apply(this._data[type][name][key], value);
	else
		this._data[type][name][key] = value;
	// we can merge objects together unlike node-irc by passing value in as an array
	// which can also have multiple objects in, to save us from looping, let V8 do the work.
};

Client.prototype._getData = function(type, name, message) {
	if (!type || !name || !message || !this._data[type][name]) {
		return false;
	}
	// safe guarding parameters

	name = name.toLowerCase();
	this._data[type][name].time = Helper.time(this._cap.enabled, message);

	return this._data[type][name];
};

Client.prototype._clearData = function(type, name) {
	if (!type || !name || !this._data[type][name]) {
		return false;
	}
	// safe guarding parameters

	name = name.toLowerCase();
	delete this._data[type][name];
};
// ========================================

// ========================================
// The below functions are utility functions which handle things like 
// handling incoming ctcp methods

Client.prototype._handleCTCP = function (message, text, type) {
	text = (text[0] == '+') ? text.slice(2) : text.slice(1);
	text = text.slice(0, text.indexOf('\1'));

	var parts = _.without(text.split(/ +/), ''),
		to = message.params[0];

	if (type === 'PRIVMSG' && parts[0].toUpperCase() === 'ACTION') {
		Events.emit([this.key, 'action'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			target: to,
			message: parts.slice(1).join(' '),
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
		// handle actions here
	} else if (type === 'PRIVMSG' && parts[0].toUpperCase() === 'VERSION') {
		Events.emit([this.key, 'ctcp_request'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			type: 'VERSION',
			target: to,
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
		// handle versions here. We send this to the host and let them reply by sending
		// a ctcp reply back like so: Client.ctcp(to, 'VERSION', 'Awesomebot 1.0');
		// we prepend "; irc-factory 0.1.2" to the end in ctcp
	} else if (type === 'PRIVMSG') {
		Events.emit([this.key, 'ctcp_request'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			target: to,
			type: parts[0].toUpperCase(),
			message: parts.slice(1).join(' '),
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
		// handle all other ctcp requests
	} else if (type === 'NOTICE') {
		Events.emit([this.key, 'ctcp_response'], {
			nickname: message.nickname,
			username: message.username,
			hostname: message.hostname,
			target: to,
			type: parts[0].toUpperCase(),
			message: parts.slice(1).join(' '),
			time: Helper.time(this._cap.enabled, message),
			raw: message.raw
		});
		// these are ctcp responses from our requests
	}
};

Client.prototype._sendRegistered = function(message) {
	this._retryCount = 0;
	// reset retry count

	Events.emit([this.key, 'registered'], {
		nickname: this._nick,
		capabilities: _.omit(this.supported, 'raw'),
		time: Helper.time(this._cap.enabled, message),
		raw: this.supported.raw
	});
	// this is our final 001-005 stuff coming out
};

Client.prototype._connectEvent = function() {
	if (typeof this.connection.localPort === 'undefined') {
		return false;
	}

	Events.emit([this.key, 'opened'], {
		nickname: this._nick,
		username: this.options.user,
		server: this.options.server,
		port: this.options.port,
		localPort: this.connection.localPort
	});
};

Client.prototype._timeoutEvent = function() {
	if (this._requestedDisconnect) {
		return false;
	}
	// no point pinging, been told to disconnect
	
	if (++this._pings > 1) {
		this.disconnect();
	} else {
		this.raw(['PING', new Date().getTime().toString()]);
	}
};

Client.prototype._closeEvent = function() {
	var self = this,
		count = this.options.retryCount || 10,
		time = this.options.retryWait || 1000,
		reconnect = false;

	if (this._retryCount < count) {
		reconnect = true;
		self._retryCount++;
	}

	if (this._retryCount == count) {
		reconnect = false;
		Events.emit([this.key, 'failed'], {
			time: Helper.time(self._cap.enabled, {}),
			reconnecting: reconnect,
			attempts: self._retryCount
		});

		return;
		// we're done here, emit failed and prevent this from happening again
	} else {
		Events.emit([this.key, 'closed'], {
			time: Helper.time(self._cap.enabled, {}),
			reconnecting: (this._requestedDisconnect) ? false : reconnect,
			attempts: self._retryCount
		});
		// emit a close event

		if (this._requestedDisconnect) {
			return false;
		}
		// bail now.

		this._retryTimer = setTimeout(function() {
			self.reconnect();
		}, time);
		// now lets try a reconnect
	}
};
// ========================================

exports.Helper = Helper;
exports.Events = Events;
exports.Client = Client;
