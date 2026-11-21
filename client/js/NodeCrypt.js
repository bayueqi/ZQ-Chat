// NodeCrypt core cryptographic client for secure chat
// NodeCrypt 安全聊天的核心加密客户端

import {
	sha256
} from 'js-sha256';
import {
	ec as elliptic
} from 'elliptic';
import {
	ModeOfOperation
} from 'aes-js';
import chacha from 'js-chacha20';
import {
	Buffer
} from 'buffer';
window.Buffer = Buffer;

// 超过这个长度的帧一定是文件分卷，走线程池解密
const LARGE_FRAME_BYTES = 128 * 1024;
// 单个加密任务的最长等待，超时退回主线程，避免线程卡死时消息全堵
const CIPHER_TASK_TIMEOUT_MS = 20000;

// 加解密线程池。整卷的加密解密放在 worker 里跑，主线程只负责切片与写连接
class CipherPool {
	constructor(size, onError) {
		this.workers = [];
		this.pending = new Map();
		this.seq = 0;
		this.cursor = 0;
		this.failed = false;
		this.onError = onError || null;
		try {
			for (let i = 0; i < size; i++) {
				const worker = new Worker(new URL('./crypt.worker.js', import.meta.url), {
					type: 'module'
				});
				worker.onmessage = (event) => this.settle(event.data);
				worker.onerror = (event) => {
					this.failed = true;
					if (this.onError) this.onError(event)
				};
				this.workers.push(worker)
			}
		} catch (error) {
			this.failed = true;
			if (this.onError) this.onError(error)
		}
	}

	get ready() {
		return !this.failed && this.workers.length > 0
	}

	settle(message) {
		const task = this.pending.get(message.id);
		if (!task) {
			return
		}
		this.pending.delete(message.id);
		if (message.error) {
			task.reject(new Error(message.error))
		} else {
			task.resolve(message.result)
		}
	}

	run(op, args) {
		if (!this.ready) {
			return Promise.reject(new Error('cipher pool unavailable'))
		}
		const id = ++this.seq;
		const worker = this.workers[this.cursor++ % this.workers.length];
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error('cipher task timeout'))
				}
			}, CIPHER_TASK_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value)
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error)
				}
			});
			worker.postMessage(Object.assign({
				id,
				op
			}, args))
		})
	}

	destroy() {
		for (const worker of this.workers) {
			try {
				worker.terminate()
			} catch (error) {}
		}
		this.workers = [];
		this.pending.clear()
	}
}

// 多个房间共用一个池，线程数按本机核数定，避免开房间越多线程越膨胀
let sharedCipherPool = null;

function getCipherPool() {
	if (sharedCipherPool) {
		return sharedCipherPool
	}
	if (typeof Worker === 'undefined' || typeof URL === 'undefined') {
		return null
	}
	const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
	const size = Math.max(2, Math.min(4, cores - 1));
	try {
		sharedCipherPool = new CipherPool(size, (error) => {
			if (typeof console !== 'undefined') console.warn('cipher pool', error)
		})
	} catch (error) {
		sharedCipherPool = null
	}
	return sharedCipherPool
}

// Main NodeCrypt class for secure communication
// 用于安全通信的 NodeCrypt 主类
class NodeCrypt {
	// Initialize NodeCrypt instance
	// 初始化 NodeCrypt 实例
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
		};
		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';
		try {
			this.clientEc = new elliptic('curve25519')
		} catch (error) {
			this.logEvent('constructor', error, 'error')
		}
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.channel = {};
		this.setCredentials = this.setCredentials.bind(this);
		this.connect = this.connect.bind(this);
		this.destruct = this.destruct.bind(this);
		this.onOpen = this.onOpen.bind(this);
		this.onMessage = this.onMessage.bind(this);
		this.onError = this.onError.bind(this);
		this.onClose = this.onClose.bind(this);
		this.logEvent = this.logEvent.bind(this);
		this.isOpen = this.isOpen.bind(this);
		this.isClosed = this.isClosed.bind(this);
		this.startReconnect = this.startReconnect.bind(this);
		this.stopReconnect = this.stopReconnect.bind(this);
		this.startPing = this.startPing.bind(this);
		this.stopPing = this.stopPing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendChannelMessage = this.sendChannelMessage.bind(this);
		this.encryptServerMessage = this.encryptServerMessage.bind(this);
		this.decryptServerMessage = this.decryptServerMessage.bind(this);
		this.encryptClientMessage = this.encryptClientMessage.bind(this);
		this.decryptClientMessage = this.decryptClientMessage.bind(this);
		this.sendChannelMessageAsync = this.sendChannelMessageAsync.bind(this);
		this.processServerDecrypted = this.processServerDecrypted.bind(this);
		this.handleClientDecrypted = this.handleClientDecrypted.bind(this);
		this.handleLargeFrame = this.handleLargeFrame.bind(this);
		this.cipherPool = getCipherPool()
	}

	// Set user credentials (username, channel, password)
	// 设置用户凭证（用户名、频道、密码）
	setCredentials(username, channel, password) {
		this.logEvent('setCredentials');
		try {
			this.credentials = {
				username: username,
				channel: sha256(channel),
				password: sha256(password)
			}
		} catch (error) {
			this.logEvent('setCredentials', error, 'error');
			return (false)
		}
		return (true)
	}

	// Connect to the server
	// 连接到服务器
	connect() {
		if (!this.credentials) {
			return (false)
		}
		this.logEvent('connect', this.config.wsAddress);
		this.stopReconnect();
		this.stopPing();
		this.serverKeys = null;
		this.serverShared = null;
		this.channel = {};
		try {
			this.connection = new WebSocket(this.config.wsAddress);
			this.connection.onopen = this.onOpen;
			this.connection.onmessage = this.onMessage;
			this.connection.onerror = this.onError;
			this.connection.onclose = this.onClose
		} catch (error) {
			this.logEvent('connect', error, 'error');
			return (false)
		}
		return (true)
	}

	// Clean up and disconnect
	// 清理并断开连接
	destruct() {
		this.logEvent('destruct');
		this.stopReconnect();
		this.stopPing();
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 15000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
		this.clientEc = null;
		this.serverKeys = null;
		this.serverShared = null;
		this.credentials = null;
		this.connection.onopen = null;
		this.connection.onmessage = null;
		this.connection.onerror = null;
		this.connection.onclose = null;
		try {
			this.connection.removeAllListeners()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		try {
			this.connection.close()
		} catch (error) {
			this.logEvent('destruct', error, 'error')
		}
		this.connection = null;
		this.channel = {};
		return (true)
	}

	// WebSocket open event handler
	// WebSocket 连接打开事件处理
	async onOpen() {
		this.logEvent('onOpen');
		this.startPing();
		try {
			this.serverKeys = await crypto.subtle.generateKey({
				name: 'ECDH',
				namedCurve: 'P-384'
			}, false, ['deriveKey', 'deriveBits']);
			this.serverShared = null;
			this.sendMessage(Buffer.from(await crypto.subtle.exportKey('raw', this.serverKeys.publicKey)).toString('hex'))
		} catch (error) {
			this.logEvent('onOpen', error, 'error')
		}
	}

	// WebSocket message event handler
	// WebSocket 消息事件处理
	async onMessage(event) {
		if (!event || !this.isString(event.data)) {
			return
		}
		// 任何服务端消息都算连接还活着，不只看 pong
		this.lastActivityAt = Date.now();
		if (event.data === 'pong') {
			this.lastPongAt = Date.now();
			return
		}
		this.logEvent('onMessage', event.data);
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'server-key') {
				const result = await this.handleServerKey(data.key);
				if (!result) {
					return
				}
			}
		} catch (e) {}
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (!parts[0] || !parts[1]) {
				return
			}
			try {
				if (await crypto.subtle.verify({
						name: 'RSASSA-PKCS1-v1_5'
					}, await crypto.subtle.importKey('spki', Buffer.from(this.config.rsaPublic, 'base64'), {
						name: 'RSASSA-PKCS1-v1_5',
						hash: {
							name: 'SHA-256'
						}
					}, false, ['verify']), Buffer.from(parts[1], 'base64'), Buffer.from(parts[0], 'hex')) === true) {
					this.serverShared = Buffer.from(await crypto.subtle.deriveBits({
						name: 'ECDH',
						namedCurve: 'P-384',
						public: await crypto.subtle.importKey('raw', Buffer.from(parts[0], 'hex'), {
							name: 'ECDH',
							namedCurve: 'P-384'
						}, true, [])
					}, this.serverKeys.privateKey, 384)).slice(8, 40);
					this.sendMessage(this.encryptServerMessage({
						a: 'j',
						p: this.credentials.channel
					}, this.serverShared));
					// 握手成功，重连退避从头计算
					this.reconnectAttempts = 0;
					if (this.callbacks.onServerSecured) {
						try {
							this.callbacks.onServerSecured()
						} catch (error) {
							this.logEvent('onMessage-server-secured-callback', error, 'error')
						}
					}
				}
			} catch (error) {
				this.logEvent('onMessage', error, 'error')
			}
			return
		}
		// 文件分卷整帧交给线程池，主线程不被几百 KB 的加解密卡住；
		// 期间到达的普通消息照常同步处理，不会被分卷堵在后面
		if (this.cipherPool && this.cipherPool.ready && event.data.length >= LARGE_FRAME_BYTES) {
			this.handleLargeFrame(event.data);
			return
		}
		this.processServerDecrypted(this.decryptServerMessage(event.data, this.serverShared))
	}

	// 分卷整帧解密：外层通道与内层客户端层都在线程池完成
	async handleLargeFrame(frame) {
		try {
			const channel = {};
			for (const clientId in this.channel) {
				if (this.channel[clientId].shared) {
					channel[clientId] = this.channel[clientId].shared
				}
			}
			const result = await this.cipherPool.run('unpack', {
				frame,
				serverKey: this.serverShared,
				channel
			});
			if (!result) {
				return
			}
			if (result.kind === 'client') {
				this.handleClientDecrypted(result.cid, result.data)
			} else {
				this.processServerDecrypted(result.data)
			}
		} catch (error) {
			this.logEvent('handleLargeFrame', error, 'error');
			// 线程池异常时退回主线程，宁可慢也不丢消息
			this.processServerDecrypted(this.decryptServerMessage(frame, this.serverShared))
		}
	}

	// 已解开外层通道的消息
	processServerDecrypted(serverDecrypted) {
		this.logEvent('onMessage-server-decrypted', serverDecrypted);
		if (!this.isObject(serverDecrypted) || !this.isString(serverDecrypted.a)) {
			return
		}
		if (serverDecrypted.a === 'l' && this.isArray(serverDecrypted.p)) {
			try {
				for (const clientId in this.channel) {
					if (serverDecrypted.p.indexOf(clientId) < 0) {
						delete(this.channel[clientId])
					}
				}
				let payloads = {};
				for (const clientId of serverDecrypted.p) {
					if (!this.channel[clientId]) {
						this.channel[clientId] = {
							username: null,
							keys: this.clientEc.genKeyPair(),
							shared: null,
						};
						payloads[clientId] = this.channel[clientId].keys.getPublic('hex')
					}
				}
				if (Object.keys(payloads).length > 0) {
					this.sendMessage(this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared))
				}
			} catch (error) {
				this.logEvent('onMessage-list', error, 'error')
			}
			if (this.callbacks.onClientList) {
				let clients = [];
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						clients.push({
							clientId: clientId,
							username: this.channel[clientId].username
						})
					}
				}
				try {
					this.callbacks.onClientList(clients)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
				if (!this.channel[serverDecrypted.c]) {
					this.channel[serverDecrypted.c] = {
						username: null,
						keys: this.clientEc.genKeyPair(),
						shared: null,
					};
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						p: this.channel[serverDecrypted.c].keys.getPublic('hex'),
						c: serverDecrypted.c
					}, this.serverShared))
				}
				this.channel[serverDecrypted.c].shared = Buffer.from(this.xorHex(this.channel[serverDecrypted.c].keys.derive(this.clientEc.keyFromPublic(serverDecrypted.p, 'hex').getPublic()).toString('hex').padEnd(64, '8').substr(0, 64), this.credentials.password), 'hex');
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					p: this.encryptClientMessage({
						a: 'u',
						p: this.credentials.username
					}, this.channel[serverDecrypted.c].shared),
					c: serverDecrypted.c
				}, this.serverShared))
			} catch (error) {
				this.logEvent('onMessage-client', error, 'error')
			}
			return
		}
		if (serverDecrypted.a === 'c' && this.channel[serverDecrypted.c] && this.channel[serverDecrypted.c].shared) {
			this.handleClientDecrypted(serverDecrypted.c, this.decryptClientMessage(serverDecrypted.p, this.channel[serverDecrypted.c].shared))
		}
	}

	// 内层消息已解开：用户名上报，或一条普通消息
	handleClientDecrypted(cid, clientDecrypted) {
		this.logEvent('onMessage-client-decrypted', clientDecrypted);
		if (!this.isObject(clientDecrypted) || !this.isString(clientDecrypted.a)) {
			return
		}
		const peer = this.channel[cid];
		if (!peer) {
			return
		}
		if (clientDecrypted.a === 'u' && this.isString(clientDecrypted.p) && clientDecrypted.p.match(/\S+/) && !peer.username) {
			peer.username = clientDecrypted.p.replace(/^\s+/, '').replace(/\s+$/, '');
			if (this.callbacks.onClientSecured) {
				try {
					this.callbacks.onClientSecured({
						clientId: cid,
						username: peer.username
					})
				} catch (error) {
					this.logEvent('onMessage-client-secured-callback', error, 'error')
				}
			}
			return
		}
		if (!peer.username) {
			return
		}
		if (clientDecrypted.a === 'm' && this.isString(clientDecrypted.t) && (this.isString(clientDecrypted.d) || this.isObject(clientDecrypted.d))) {
			if (this.callbacks.onClientMessage) {
				try {
					this.callbacks.onClientMessage({
						clientId: cid,
						username: peer.username,
						type: clientDecrypted.t,
						data: clientDecrypted.d
					})
				} catch (error) {
					this.logEvent('onMessage-client-message-callback', error, 'error')
				}
			}
		}
	}

	// WebSocket error event handler
	// WebSocket 错误事件处理
	async onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onError-server-closed-callback', error, 'error')
			}
		}
	}

	// WebSocket close event handler
	// WebSocket 关闭事件处理
	async onClose(event) {
		this.logEvent('onClose', event);
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onClose-server-closed-callback', error, 'error')
			}
		}
	}

	// Log events for debugging
	// 记录事件日志用于调试
	logEvent(source, message, level) {
		if (this.config.debug) {
			const date = new Date(),
				dateString = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2);
			console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''))
		}
	}

	// Check if connection is open
	// 检查连接是否已打开
	isOpen() {
		return (this.connection && this.connection.readyState && this.connection.readyState === WebSocket.OPEN ? true : false)
	}

	// Check if connection is closed
	// 检查连接是否已关闭
	isClosed() {
		return (!this.connection || !this.connection.readyState || this.connection.readyState === WebSocket.CLOSED ? true : false)
	}

	// Start reconnect timer
	// 启动重连定时器
	startReconnect() {
		this.stopReconnect();
		this.logEvent('startReconnect');
		// 连续失败时逐次拉长间隔，避免每隔几秒握手一次把连接反复打断
		this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
		const delay = Math.min(this.config.reconnectDelay * this.reconnectAttempts, 30000);
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect()
		}, delay)
	}

	// Stop reconnect timer
	// 停止重连定时器
	stopReconnect() {
		if (this.reconnect) {
			this.logEvent('stopReconnect');
			clearTimeout(this.reconnect);
			this.reconnect = null
		}
	}

	// Start ping timer
	// 启动心跳定时器
	startPing() {
		this.stopPing();
		this.logEvent('startPing');
		this.lastPongAt = Date.now();
		this.lastActivityAt = Date.now();

		if (typeof document !== 'undefined' && !this.visibilityBound) {
			this.visibilityBound = true;
			document.addEventListener('visibilitychange', () => {
				if (!document.hidden) {
					// 后台期间定时器被节流，回到前台补齐一次心跳，避免误判掉线
					this.lastPongAt = Date.now();
					this.lastActivityAt = Date.now();
					this.sendMessage('ping');
				}
			});
		}

		this.ping = setInterval(() => {
			// 标签页在后台时定时器会被浏览器节流，此时不能据此判断连接状态
			if (typeof document !== 'undefined' && document.hidden) {
				return
			}
			// 连续多个周期连任何服务端消息都收不到，才认为连接已在中间环节断开。
			// 阈值放宽，避免服务端转发繁忙时误判，把正常连接反复踢掉重连
			const lastSeen = Math.max(this.lastPongAt || 0, this.lastActivityAt || 0);
			if (Date.now() - lastSeen > this.config.pingInterval * 6) {
				this.logEvent('ping-timeout');
				this.disconnect();
				if (this.credentials && this.callbacks.onServerClosed) {
					try {
						this.callbacks.onServerClosed()
					} catch (error) {
						this.logEvent('ping-timeout-callback', error, 'error')
					}
				}
				if (this.credentials) {
					this.startReconnect()
				}
				return
			}
			this.sendMessage('ping')
		}, this.config.pingInterval)
	}

	// Stop ping timer
	// 停止心跳定时器
	stopPing() {
		if (this.ping) {
			this.logEvent('stopPing');
			clearInterval(this.ping);
			this.ping = null
		}
	}

	// Disconnect from server
	// 从服务器断开连接
	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (!this.isClosed()) {
			try {
				this.logEvent('disconnect');
				this.connection.close()
			} catch (error) {
				this.logEvent('disconnect', error, 'error')
			}
		}
	}

	// Send a message to the server
	// 向服务器发送消息
	sendMessage(message) {
		try {
			if (this.isOpen()) {
				this.connection.send(message);
				return (true)
			}
		} catch (error) {
			this.logEvent('sendMessage', error, 'error')
		}
		return (false)
	}

	// Send a message to all channels
	// 向所有频道发送消息
	sendChannelMessage(type, data) {
		if (this.serverShared) {
			try {
				let payloads = {};
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						payloads[clientId] = this.encryptClientMessage({
							a: 'm',
							t: type,
							d: data
						}, this.channel[clientId].shared);
						if (payloads[clientId].length === 0) {
							return (false)
						}
					}
				}
				// 频道里没有完成密钥交换的接收者时消息发不出去，必须返回失败，
				// 否则调用方会以为已经发送成功（重连瞬间就会走到这里）
				if (Object.keys(payloads).length === 0) {
					return (false)
				}
				const payload = this.encryptServerMessage({
					a: 'w',
					p: payloads,
				}, this.serverShared);
				if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
					return (false)
				}
				this.connection.send(payload)
				return (true)
			} catch (error) {
				this.logEvent('sendChannelMessage', error, 'error')
			}
		}
		return (false)
	}

	// 频道广播的异步版本：整卷加解密在线程池完成，主线程只负责写入连接
	sendChannelMessageAsync(type, data) {
		if (!this.serverShared) {
			return Promise.resolve(false)
		}
		const targets = [];
		for (const clientId in this.channel) {
			if (this.channel[clientId].shared && this.channel[clientId].username) {
				targets.push({
					cid: clientId,
					key: this.channel[clientId].shared
				})
			}
		}
		// 频道里没有完成密钥交换的接收者时消息发不出去，必须返回失败
		if (targets.length === 0) {
			return Promise.resolve(false)
		}
		const serverKey = this.serverShared;
		const write = (payload) => {
			if (!payload || typeof payload !== 'string' || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
				return false
			}
			if (!this.isOpen()) {
				return false
			}
			this.connection.send(payload);
			return true
		};
		if (!this.cipherPool || !this.cipherPool.ready) {
			return Promise.resolve(this.sendChannelMessage(type, data))
		}
		return this.cipherPool.run('pack', {
			type,
			data,
			targets,
			serverKey
		}).then(write, (error) => {
			this.logEvent('sendChannelMessageAsync', error, 'error');
			return this.sendChannelMessage(type, data)
		})
	}

	// 私聊：内层给指定客户端，外层走服务端通道
	sendPrivateMessage(type, data, targetId) {
		const peer = this.channel[targetId];
		if (!this.serverShared || !peer || !peer.shared) {
			return (false)
		}
		try {
			const inner = this.encryptClientMessage({
				a: 'm',
				t: type,
				d: data
			}, peer.shared);
			const payload = this.encryptServerMessage({
				a: 'c',
				p: inner,
				c: targetId
			}, this.serverShared);
			if (!payload || payload.length === 0 || payload.length > (8 * 1024 * 1024) || !this.isOpen()) {
				return (false)
			}
			this.connection.send(payload);
			return (true)
		} catch (error) {
			this.logEvent('sendPrivateMessage', error, 'error')
		}
		return (false)
	}

	// 私聊的异步版本，大文件走这条
	sendPrivateMessageAsync(type, data, targetId) {
		const peer = this.channel[targetId];
		if (!this.serverShared || !peer || !peer.shared) {
			return Promise.resolve(false)
		}
		if (!this.cipherPool || !this.cipherPool.ready) {
			return Promise.resolve(this.sendPrivateMessage(type, data, targetId))
		}
		return this.cipherPool.run('pack-private', {
			type,
			data,
			cid: targetId,
			key: peer.shared,
			serverKey: this.serverShared
		}).then((payload) => {
			if (!payload || payload.length === 0 || payload.length > (8 * 1024 * 1024) || !this.isOpen()) {
				return false
			}
			this.connection.send(payload);
			return true
		}, (error) => {
			this.logEvent('sendPrivateMessageAsync', error, 'error');
			return this.sendPrivateMessage(type, data, targetId)
		})
	}

	// Encrypt a message for the server
	// 加密发送给服务器的消息
	encryptServerMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				// 展开成数组再拼回去，几百 KB 的数据要多花二十多毫秒
				message = Buffer.concat([message, Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
			const cipher = new ModeOfOperation.cbc(key, iv);
			encrypted = iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptServerMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from the server
	// 解密来自服务器的消息
	decryptServerMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptServerMessage', error, 'error')
		}
		return (decrypted)
	}

	// Encrypt a message for a client
	// 加密发送给客户端的消息
	encryptClientMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.concat([message, Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const counter = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
			const cipher = new chacha(key, iv, counter.reduce((a, b) => a * b));
			encrypted = iv.toString('base64') + '|' + counter.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptClientMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from a client
	// 解密来自客户端的消息
	decryptClientMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new chacha(key, Buffer.from(parts[0], 'base64'), Buffer.from(parts[1], 'base64').reduce((a, b) => a * b));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[2], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptClientMessage', error, 'error')
		}
		return (decrypted)
	}

	// XOR two hex strings
	// 对两个十六进制字符串进行异或
	xorHex(a, b) {
		let result = '',
			hexLength = Math.min(a.length, b.length);
		for (let i = 0; i < hexLength; ++i) {
			result += (parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16)).toString(16)
		}
		return (result)
	}

	// Check if value is a string
	// 检查值是否为字符串
	isString(value) {
		return (value && Object.prototype.toString.call(value) === '[object String]' ? true : false)
	}

	// Check if value is an array
	// 检查值是否为数组
	isArray(value) {
		return (value && Object.prototype.toString.call(value) === '[object Array]' ? true : false)
	}

	// Check if value is an object
	// 检查值是否为对象
	isObject(value) {
		return (value && Object.prototype.toString.call(value) === '[object Object]' ? true : false)
	}

	// Handle server public key
	// 处理服务器公钥
	async handleServerKey(serverKey) {
		this.logEvent('handleServerKey', 'Received server key');
		localStorage.removeItem(this.SERVER_KEY_STORAGE);
		localStorage.setItem(this.SERVER_KEY_STORAGE, serverKey);
		this.config.rsaPublic = serverKey;
		return true
	}
};

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt
}