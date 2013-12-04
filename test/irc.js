var should = require('should'),
	MockGenericSocket = require('../lib/stub.js');
	irc = require('../lib/irc.js'),
	Events = irc.Events,
	Client = irc.Client;

var network = Object.freeze({
    nick : 'testbot',
    user : 'testuser',
    server : 'irc.freenode.net',
    realname: 'realbot',
    port: 6667,
    secure: false
});

describe('registered event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 001 testbot :Welcome to the Test IRC Network testbot!testuser@localhost',
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('registered event should have nickname property', function (done) {
		setup();
		Events.once('key.registered', function(o) {
			o.should.have.property('nickname');
			done();
		});
	});

	it('registered event nickname property should equal testbot', function (done) {
		setup();
		Events.once('key.registered', function(o) {
			o.nickname.should.equal('testbot');
			done();
		});
	});
});

describe('capabilities event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 004 testbot moorcock.freenode.net ircd-seven-1.1.3 DOQRSZaghilopswz CFILMPQSbcefgijklmnopqrstvz bkloveqjfI',
			':sendak.freenode.net 005 testbot CHANTYPES=# EXCEPTS INVEX CHANMODES=eIbq,k,flj,CFLMPQScgimnprstz CHANLIMIT=#:120 PREFIX=(ov)@+ MAXLIST=bqeI:100 MODES=4 NETWORK=freenode KNOCKSTATUSMSG=@+ CALLERID=g :are supported by this server',
			':sendak.freenode.net 005 testbot CASEMAPPING=rfc1459 CHARSET=ascii NICKLEN=16 CHANNELLEN=50 TOPICLEN=390 ETRACE CPRIVMSG CNOTICE DEAF=D MONITOR=100 FNC TARGMAX=NAMES:1,LIST:1,KICK:1,WHOIS:1,PRIVMSG:4,NOTICE:4,ACCEPT:,MONITOR: :are supported by this server',
			':sendak.freenode.net 005 testbot EXTBAN=$,arxz WHOX CLIENTVER=3.0 SAFELIST ELIST=CTU :are supported by this server'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('capabilities event should have correct object format', function (done) {
		setup();
		Events.once('key.capabilities', function(o) {
			o.should.have.property('channel');
			o.channel.should.have.properties('idlength', 'limit', 'modes', 'prefixes', 'types');
			o.should.have.properties('kicklength', 'maxlist', 'maxtargets', 'modes', 'modeForPrefix', 'prefixForMode', 'nicklength', 'topiclength', 'usermodes', 'name');
			done();
		});
	});

	it('capabilities event should have correct channel object', function (done) {
		setup();
		Events.once('key.capabilities', function(o) {
			o.channel.idlength.should.be.empty;
			o.channel.length.should.equal(50);
			o.channel.limit.should.eql({'#': 120});
			o.channel.modes.a.should.equal('eIbq');
			o.channel.modes.b.should.equal('kov');
			o.channel.modes.c.should.equal('flj');
			o.channel.modes.d.should.equal('CFLMPQScgimnprstz');
			o.channel.prefixes.should.equal('@+');
			o.channel.types.should.equal('#');
			done();
		});
	});

	it('capabilities event should have correct values', function (done) {
		setup();
		Events.once('key.capabilities', function(o) {
			o.kicklength.should.equal(0);
			o.maxlist.should.eql({bqeI: 100});
			o.maxtargets.should.eql({NAMES: 1, LIST: 1, KICK: 1, WHOIS: 1, PRIVMSG: 4,
				NOTICE: 4, ACCEPT: 0, MONITOR: 0});
			o.modes.should.equal(3);
			o.modeForPrefix.should.eql({'@': 'o', '+': 'v'});
			o.prefixForMode.should.eql({'o': '@', 'v': '+'});
			o.nicklength.should.equal(16);
			o.topiclength.should.equal(390);
			o.usermodes.should.equal('DOQRSZaghilopswz');
			o.name.should.equal('freenode');
			done();
		});
	});
});

describe('motd event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 375 testbot :- sendak.freenode.net Message of the Day -',
			':sendak.freenode.net 372 testbot :- Welcome to moorcock.freenode.net in Texas, USA. Thanks to',
			':sendak.freenode.net 372 testbot :- Kodingen (http://kodingen.com) for sponsoring this server!',
			':sendak.freenode.net 376 testbot :End of /MOTD command.'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('motd should be correct', function (done) {
		setup();
		Events.once('key.motd', function(o) {
			o.should.eql(['- sendak.freenode.net Message of the Day -',
				'- Welcome to moorcock.freenode.net in Texas, USA. Thanks to',
				'- Kodingen (http://kodingen.com) for sponsoring this server!',
				'End of /MOTD command.']);
			done();
		});
	});
});

describe('topic event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 332 testbot #ircanywhere :IRCAnywhere, moved to freenode. Development has restarted using meteor.js in 0.2.0 branch https://github.com/ircanywhere/ircanywhere/tree/0.2.0',
			':sendak.freenode.net 333 testbot #ircanywhere rickibalboa!~ricki@unaffiliated/rickibalboa 1385050715'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('topic event should have correct object format', function (done) {
		setup();
		Events.once('key.topic', function(o) {
			o.should.have.properties('channel', 'topic', 'topicBy');
			done();
		});
	});

	it('channel should be correct', function (done) {
		setup();
		Events.once('key.topic', function(o) {
			o.channel.should.equal('#ircanywhere');
			done();
		});
	});

	it('topic should be correct', function (done) {
		setup();
		Events.once('key.topic', function(o) {
			o.topic.should.have.equal('IRCAnywhere, moved to freenode. Development has restarted using meteor.js in 0.2.0 branch https://github.com/ircanywhere/ircanywhere/tree/0.2.0');
			done();
		});
	});

	it('topic setter should be correct', function (done) {
		setup();
		Events.once('key.topic', function(o) {
			o.topicBy.should.have.equal('rickibalboa!~ricki@unaffiliated/rickibalboa');
			done();
		});
	});
});

describe('names event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 353 testbot = #ircanywhere :testbot Not-002 @rickibalboa @Gnasher Venko [D3M0N] lyska @ChanServ LoganLK JakeXKS Techman TkTech zz_Trinexx Tappy',
			':sendak.freenode.net 366 testbot #ircanywhere :End of /NAMES list.'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('names event should have correct object format', function (done) {
		setup();
		Events.once('key.names', function(o) {
			o.should.have.properties('channel', 'names');
			done();
		});
	});

	it('channel should be correct', function (done) {
		setup();
		Events.once('key.names', function(o) {
			o.channel.should.equal('#ircanywhere');
			done();
		});
	});

	it('names array should be correct', function (done) {
		setup();
		Events.once('key.names', function(o) {
			o.names.should.have.eql(['testbot', 'Not-002', '@rickibalboa',  '@Gnasher', 'Venko', '[D3M0N]', 'lyska', '@ChanServ', 'LoganLK', 'JakeXKS',  'Techman', 'TkTech', 'zz_Trinexx', 'Tappy' ]);
			done();
		});
	});
});

describe('who event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 352 testbot #ircanywhere ~node 84.12.104.27 sendak.freenode.net testbot H :0 node',
			':sendak.freenode.net 352 testbot #ircanywhere ~notifico 198.199.82.216 hubbard.freenode.net Not-002 H :0 Notifico! - http://n.tkte.ch/',
			':sendak.freenode.net 352 testbot #ircanywhere ~ricki unaffiliated/rickibalboa leguin.freenode.net rickibalboa H@ :0 Ricki',
			':sendak.freenode.net 352 testbot #ircanywhere Three host-92-3-234-146.as43234.net card.freenode.net Gnasher H@ :0 Dave',
			':sendak.freenode.net 352 testbot #ircanywhere venko Colchester-LUG/Legen.dary rothfuss.freenode.net Venko H :0 venko',
			':sendak.freenode.net 352 testbot #ircanywhere ~D3M0N irc.legalizeourmarijuana.us leguin.freenode.net [D3M0N] H :0 The Almighty D3V1L!',
			':sendak.freenode.net 352 testbot #ircanywhere ~lyska op.op.op.oppan.ganghamstyle.pw hobana.freenode.net lyska H :0 Sam Dodrill <niichan@ponychat.net>',
			':sendak.freenode.net 352 testbot #ircanywhere ChanServ services. services. ChanServ H@ :0 Channel Services',
			':sendak.freenode.net 352 testbot #ircanywhere ~LoganLK 162.243.133.98 rothfuss.freenode.net LoganLK H :0 Logan',
			':sendak.freenode.net 352 testbot #ircanywhere sid15915 gateway/web/irccloud.com/x-uvcbvvujowjeeaga leguin.freenode.net JakeXKS G :0 Jake',
			':sendak.freenode.net 352 testbot #ircanywhere sid11863 gateway/web/irccloud.com/x-qaysfvklhrsppher leguin.freenode.net Techman G :0 Michael Hazell',
			':sendak.freenode.net 352 testbot #ircanywhere ~TkTech irc.tkte.ch kornbluth.freenode.net TkTech H :0 TkTech',
			':sendak.freenode.net 352 testbot #ircanywhere ~Trinexx tecnode-gaming.com wolfe.freenode.net zz_Trinexx H :0 Jake',
			':sendak.freenode.net 352 testbot #ircanywhere ~Tappy 2605:6400:2:fed5:22:fd8f:98fd:7a74 morgan.freenode.net Tappy H :0 Tappy',
			':sendak.freenode.net 315 testbot #ircanywhere :End of /WHO list.'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('who event should have correct object format', function (done) {
		setup();
		Events.once('key.who', function(o) {
			o.should.have.properties('channel', 'who');
			done();
		});
	});

	it('channel should be correct', function (done) {
		setup();
		Events.once('key.who', function(o) {
			o.channel.should.equal('#ircanywhere');
			done();
		});
	});

	it('who array should be correct', function (done) {
		setup();
		Events.once('key.who', function(o) {
			o.who.should.have.a.lengthOf(14);
			o.who[0].chan.should.equal('#ircanywhere');
			o.who[0].prefix.should.equal('~node@84.12.104.27');
			o.who[0].nick.should.equal('testbot');
			o.who[0].mode.should.equal('H');
			o.who[0].extra.should.equal('0 node');
			done();
		});
	});
});

describe('whois event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':sendak.freenode.net 311 testbot rickibalboa ~ricki unaffiliated/rickibalboa * :Ricki',
			':sendak.freenode.net 319 testbot rickibalboa :@#ircanywhere',
			':sendak.freenode.net 312 testbot rickibalboa leguin.freenode.net :Ume?, SE, EU',
			':sendak.freenode.net 671 testbot rickibalboa :is using a secure connection',
			':sendak.freenode.net 330 testbot rickibalboa rickibalboa :is logged in as',
			':sendak.freenode.net 318 testbot rickibalboa :End of /WHOIS list.'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('whois event should have correct object format', function (done) {
		setup();
		Events.once('key.whois', function(o) {
			o.should.have.properties('nickname', 'user', 'host', 'realname', 'channels', 'server', 'serverinfo', 'secure');
			done();
		});
	});

	it('whois object should be correct', function (done) {
		setup();
		Events.once('key.whois', function(o) {
			o.nickname.should.equal('rickibalboa');
			o.user.should.equal('~ricki');
			o.host.should.equal('unaffiliated/rickibalboa');
			o.realname.should.equal('Ricki');
			o.channels.should.eql(['@#ircanywhere']);
			o.server.should.equal('leguin.freenode.net');
			o.serverinfo.should.equal('Ume?, SE, EU');
			o.secure.should.equal('is using a secure connection');
			done();
		});
	});
});

describe('user mode event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':testbot MODE testbot :+i'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('mode object should have correct format', function (done) {
		setup();
		Events.once('key.usermode', function(o) {
			o.should.have.properties('nickname', 'mode');
			done();
		});
	});

	it('nick and mode should be correct', function (done) {
		setup();
		Events.once('key.usermode', function(o) {
			o.nickname.should.equal('testbot');
			o.mode.should.equal('+i');
			done();
		});
	});
});

describe('mode event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa MODE #ircanywhere-test +i'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('mode object should have correct format', function (done) {
		setup();
		Events.once('key.mode', function(o) {
			o.should.have.properties('channel', 'mode', 'modeBy');
			done();
		});
	});

	it('channel and mode should be correct', function (done) {
		setup();
		Events.once('key.mode', function(o) {
			o.channel.should.equal('#ircanywhere-test');
			o.modeBy.should.equal('rickibalboa');
			o.mode.should.equal('+i');
			done();
		});
	});
});

describe('join event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa JOIN #ircanywhere-test'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('join object should have correct format', function (done) {
		setup();
		Events.once('key.join', function(o) {
			o.should.have.properties('channel', 'nickname');
			done();
		});
	});
});

describe('part event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa PART #ircanywhere-test :with a message'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('part object should have correct format', function (done) {
		setup();
		Events.once('key.part', function(o) {
			o.should.have.properties('channel', 'nickname', 'message');
			done();
		});
	});

	it('channel and nick should be correct', function (done) {
		setup();
		Events.once('key.part', function(o) {
			o.channel.should.equal('#ircanywhere-test');
			o.nickname.should.equal('rickibalboa');
			done();
		});
	});

	it('message should be correct', function (done) {
		setup();
		Events.once('key.part', function(o) {
			o.message.should.equal('with a message');
			done();
		});
	});
});

describe('kick event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa KICK #ircanywhere-test testbot :bye mate'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('kick object should have correct format', function (done) {
		setup();
		Events.once('key.kick', function(o) {
			o.should.have.properties('channel', 'nickname', 'kicked', 'message');
			done();
		});
	});

	it('values should be correct', function (done) {
		setup();
		Events.once('key.kick', function(o) {
			o.nickname.should.equal('rickibalboa');
			o.channel.should.equal('#ircanywhere-test');
			o.kicked.should.equal('testbot');
			o.message.should.equal('bye mate');
			done();
		});
	});
});

describe('quit event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa QUIT :Ping timeout: 240 seconds'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('quit object should have correct format', function (done) {
		setup();
		Events.once('key.quit', function(o) {
			o.should.have.properties('nickname', 'message');
			done();
		});
	});

	it('values should be correct', function (done) {
		setup();
		Events.once('key.quit', function(o) {
			o.nickname.should.equal('rickibalboa');
			o.message.should.equal('Ping timeout: 240 seconds');
			done();
		});
	});
});

describe('invite event', function () {
	function setup() {
		MockGenericSocket.messages = [
			':rickibalboa!~ricki@unaffiliated/rickibalboa INVITE testbot :#ircanywhere-test'
		];
		var socket = new Client('key', network, MockGenericSocket);
	};

	it('invite object should have correct format', function (done) {
		setup();
		Events.once('key.invite', function(o) {
			o.should.have.properties('nickname', 'channel');
			done();
		});
	});

	it('values should be correct', function (done) {
		setup();
		Events.once('key.invite', function(o) {
			o.nickname.should.equal('rickibalboa');
			o.channel.should.equal('#ircanywhere-test');
			done();
		});
	});
});