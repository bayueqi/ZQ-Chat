// 文件分卷加解密线程
// 算法与 NodeCrypt 主线程完全一致，这里只是把整卷的加解密搬出主线程
import {
	ModeOfOperation
} from 'aes-js';
import chacha from 'js-chacha20';
import {
	Buffer
} from 'buffer';

const asBuffer = (value) => {
	if (value instanceof Uint8Array) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
	}
	return Buffer.from(value)
};

const pad16 = (message) => {
	if ((message.length % 16) === 0) {
		return message
	}
	return Buffer.concat([message, Buffer.alloc(16 - (message.length % 16))])
};

function encryptServerMessage(message, key) {
	const body = pad16(Buffer.from(JSON.stringify(message), 'utf8'));
	const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
	const cipher = new ModeOfOperation.cbc(key, iv);
	return iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(body)).toString('base64')
}

function encryptClientMessage(message, key) {
	const body = pad16(Buffer.from(JSON.stringify(message), 'utf8'));
	const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
	const counter = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
	const cipher = new chacha(key, iv, counter.reduce((a, b) => a * b));
	return iv.toString('base64') + '|' + counter.toString('base64') + '|' + Buffer.from(cipher.encrypt(body)).toString('base64')
}

function decryptServerMessage(message, key) {
	const parts = message.split('|');
	const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
	return JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
}

function decryptClientMessage(message, key) {
	const parts = message.split('|');
	const decipher = new chacha(key, Buffer.from(parts[0], 'base64'), Buffer.from(parts[1], 'base64').reduce((a, b) => a * b));
	return JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[2], 'base64'))).toString('utf8').replace(/\0+$/, ''))
}

// 频道广播：每个接收者一份内层密文，再整体套一层服务端通道加密
function packChannel({ type, data, targets, serverKey }) {
	const payloads = {};
	for (const target of targets) {
		payloads[target.cid] = encryptClientMessage({
			a: 'm',
			t: type,
			d: data
		}, asBuffer(target.key))
	}
	if (Object.keys(payloads).length === 0) {
		return null
	}
	return encryptServerMessage({
		a: 'w',
		p: payloads
	}, asBuffer(serverKey))
}

// 私聊：内层只给一个客户端，外层走服务端通道
function packPrivate({ type, data, cid, key, serverKey }) {
	const inner = encryptClientMessage({
		a: 'm',
		t: type,
		d: data
	}, asBuffer(key));
	return encryptServerMessage({
		a: 'c',
		p: inner,
		c: cid
	}, asBuffer(serverKey))
}

// 拆帧：外层服务端通道，必要时再拆内层客户端层
function unpackFrame({ frame, serverKey, channel }) {
	const outer = decryptServerMessage(frame, asBuffer(serverKey));
	if (!outer || typeof outer !== 'object') {
		return {
			kind: 'other',
			data: outer
		}
	}
	if (outer.a === 'c' && typeof outer.p === 'string' && typeof outer.c === 'string') {
		const key = channel && channel[outer.c];
		if (!key) {
			// 还没和这个客户端完成密钥交换，内层解不开，交回主线程走握手流程
			return {
				kind: 'client-raw',
				data: outer
			}
		}
		return {
			kind: 'client',
			cid: outer.c,
			data: decryptClientMessage(outer.p, asBuffer(key))
		}
	}
	return {
		kind: 'other',
		data: outer
	}
}

self.onmessage = (event) => {
	const task = event.data;
	if (!task || !task.id) {
		return
	}
	try {
		let result;
		if (task.op === 'pack') {
			result = packChannel(task);
		} else if (task.op === 'pack-private') {
			result = packPrivate(task);
		} else if (task.op === 'unpack') {
			result = unpackFrame(task);
		} else {
			throw new Error('unknown op')
		}
		self.postMessage({
			id: task.id,
			result
		});
	} catch (error) {
		self.postMessage({
			id: task.id,
			error: String((error && error.message) || error)
		});
	}
};
