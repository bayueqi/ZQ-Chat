// Room management logic for NodeCrypt web client
// NodeCrypt 网页客户端的房间管理逻辑

import {
	createAvatarSVG
} from './util.avatar.js';
import {
	renderChatArea,
	addSystemMsg,
	updateChatInputStyle
} from './chat.js';
import {
	renderMainHeader,
	renderUserList
} from './ui.js';
import {
	escapeHTML
} from './util.string.js';
import {
	$id,
	createElement
} from './util.dom.js';
import { t } from './util.i18n.js';
let roomsData = [];
let activeRoomIndex = -1;

// 有人从成员列表中消失后，等这么久再确认是否真的离开。
// 重连的客户端会换新的 clientId，重新握手前不会出现在列表里，立即判定会误报。
const LEAVE_CONFIRM_MS = 8000;
const nameOfUser = (u) => (u && (u.userName || u.username || u.name)) || '';

// 供文件传输层取当前加密连接，用于发送背压与补发控制消息
window.getActiveChat = () => {
	const rd = roomsData[activeRoomIndex];
	return rd && rd.chat ? rd.chat : null;
};

// 供上传流程在发起时锁定目标房间，压缩大文件期间切换房间不会发错地方
window.getActiveRoomData = () => {
	return roomsData[activeRoomIndex] || null;
};

// Get a new room data object
// 获取一个新的房间数据对象
export function getNewRoomData() {
	return {
		roomName: '',
		userList: [],
		userMap: {},
		myId: null,
		myUserName: '',
		chat: null,
		messages: [],
		prevUserList: [],
		knownUserIds: new Set(),
		unreadCount: 0,
		privateChatTargetId: null,
		privateChatTargetName: null
	}
}

// Switch to another room by index
// 切换到指定索引的房间
export function switchRoom(index) {
	if (index < 0 || index >= roomsData.length) return;
	activeRoomIndex = index;
	const rd = roomsData[index];
	if (typeof rd.unreadCount === 'number') rd.unreadCount = 0;
	const sidebarUsername = document.getElementById('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = rd.myUserName;
	setSidebarAvatar(rd.myUserName);
	renderRooms(index);
	renderMainHeader();
	renderUserList(false);
	renderChatArea();
	updateChatInputStyle()
}

// Set the sidebar avatar
// 设置侧边栏头像
export function setSidebarAvatar(userName) {
	if (!userName) return;
	const svg = createAvatarSVG(userName);
	const el = $id('sidebar-user-avatar');
	if (el) {
		const cleanSvg = svg.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
		el.innerHTML = cleanSvg
	}
}

// Render the room list
// 渲染房间列表
export function renderRooms(activeId = 0) {
	const roomList = $id('room-list');
	roomList.innerHTML = '';
	roomsData.forEach((rd, i) => {
		const div = createElement('div', {
			class: 'room' + (i === activeId ? ' active' : ''),
			onclick: () => switchRoom(i)
		});
		const safeRoomName = escapeHTML(rd.roomName);
		let unreadHtml = '';
		if (rd.unreadCount && i !== activeId) {
			unreadHtml = `<span class="room-unread-badge">${rd.unreadCount>99?'99+':rd.unreadCount}</span>`
		}
		div.innerHTML = `<div class="info"><div class="title">#${safeRoomName}</div></div>${unreadHtml}`;
		roomList.appendChild(div)
	})
}

// Join a room
// 加入一个房间
export function joinRoom(userName, roomName, password, modal = null, onResult) {
	const newRd = getNewRoomData();
	newRd.roomName = roomName;
	newRd.myUserName = userName;
	newRd.password = password;
	roomsData.push(newRd);
	const idx = roomsData.length - 1;
	switchRoom(idx);
	const sidebarUsername = $id('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = userName;
	setSidebarAvatar(userName);
	let closed = false;
	const callbacks = {
		onServerClosed: () => {
			setStatus('Node connection closed');
			if (roomsData[idx]) roomsData[idx].reconnecting = true;
			if (onResult && !closed) {
				closed = true;
				onResult(false)
			}
		},		onServerSecured: () => {
			if (modal) modal.remove();
			else {
				const loginContainer = $id('login-container');
				if (loginContainer) loginContainer.style.display = 'none';
				const chatContainer = $id('chat-container');
				if (chatContainer) chatContainer.style.display = '';
				

			}
			if (onResult && !closed) {
				closed = true;
				onResult(true)
			}
			const rd = roomsData[idx];
			if (rd && rd.reconnecting) {
				// 重连后重新握手会重建成员列表，这段时间内不产生进出的系统消息
				rd.reconnecting = false;
				rd.suppressPresenceUntil = Date.now() + 8000;
			}
			// 重连同样会走一遍握手，重复提示会把聊天区刷满，只在首次建立连接时提示
			if (!rd || !rd.securedAnnounced) {
				if (rd) rd.securedAnnounced = true;
				addSystemMsg(t('system.secured', 'connection secured'))
			}
		},
		onClientSecured: (user) => handleClientSecured(idx, user),
		onClientList: (list, selfId) => handleClientList(idx, list, selfId),
		onClientLeft: (clientId) => handleClientLeft(idx, clientId),
		onClientMessage: (msg) => handleClientMessage(idx, msg)
	};
	const chatInst = new window.NodeCrypt(window.config, callbacks);
	chatInst.setCredentials(userName, roomName, password);
	chatInst.connect();
	roomsData[idx].chat = chatInst
}

// Handle the client list update
// 处理客户端列表更新
export function handleClientList(idx, list, selfId) {
	const rd = roomsData[idx];
	if (!rd) return;

	const nameOf = nameOfUser;

	// 断线重连后服务端会分配新的 clientId，同一个人看起来就成了新用户。
	// 人员是否离开按用户名判断，clientId 只用于定位记录。
	const suppressed = rd.suppressPresenceUntil && Date.now() < rd.suppressPresenceUntil;

	// 名单里重新出现的人，取消待确认的离开
	if (rd.pendingLeft) {
		for (const [pendingId, entry] of rd.pendingLeft) {
			const back = entry.name
				? list.some(u => nameOf(u) === entry.name)
				: list.some(u => u.clientId === pendingId);
			if (back) {
				clearTimeout(entry.timer);
				rd.pendingLeft.delete(pendingId);
			}
		}
	}

	if (!suppressed) {
		const newNames = new Set(list.map(nameOf).filter(Boolean));
		const retained = [];
		for (const oldUser of (rd.userList || []).slice()) {
			const name = nameOf(oldUser);
			const stillHere = name
				? newNames.has(name)
				: list.some(u => u.clientId === oldUser.clientId);
			if (!stillHere) {
				// 先留在名单里等确认，避免重连的人在界面上闪一下又回来
				scheduleClientLeft(idx, oldUser);
				retained.push(oldUser);
			}
		}
		rd.userList = list.concat(retained);
	} else {
		// 重连握手中：只并入新出现的用户，保留尚未完成密钥交换的老记录，名单不闪空
		const merged = (rd.userList || []).slice();
		for (const user of list) {
			const name = nameOf(user);
			const at = name ? merged.findIndex(u => nameOf(u) === name) : -1;
			if (at >= 0) merged[at] = user; else merged.push(user);
		}
		rd.userList = merged;
	}

	rd.userMap = {};
	rd.userList.forEach(u => {
		rd.userMap[u.clientId] = u
	});
	rd.myId = selfId;
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	rd.initCount = (rd.initCount || 0) + 1;
	if (rd.initCount === 2) {
		rd.isInitialized = true;
		rd.knownUserIds = new Set(rd.userList.map(u => u.clientId));
		rd.knownUserNames = new Set(rd.userList.map(nameOf).filter(Boolean));
	}
}

// Handle client secured event
// 处理客户端安全连接事件
export function handleClientSecured(idx, user) {
	const rd = roomsData[idx];
	if (!rd) return;

	const nameOf = (u) => (u && (u.userName || u.username || u.name)) || '';
	const userName = nameOf(user);
	const displayName = userName || t('ui.anonymous', 'Anonymous');

	// 这个人的新连接已经握手完成，取消待确认的离开
	if (userName && rd.pendingLeft) {
		for (const [pendingId, entry] of rd.pendingLeft) {
			if (entry.name === userName) {
				clearTimeout(entry.timer);
				rd.pendingLeft.delete(pendingId);
			}
		}
	}

	// 重连后同一用户会带着新的 clientId 回来，按用户名合并，避免名单里出现两个同名条目
	let at = rd.userList.findIndex(u => u.clientId === user.clientId);
	if (at < 0 && userName) {
		at = rd.userList.findIndex(u => nameOf(u) === userName);
	}
	if (at === -1) {
		rd.userList.push(user)
	} else {
		rd.userList[at] = user
	}
	rd.userMap = {};
	rd.userList.forEach(u => {
		rd.userMap[u.clientId] = u
	});
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	if (!rd.isInitialized) {
		return
	}
	if (rd.suppressPresenceUntil && Date.now() < rd.suppressPresenceUntil) {
		// 重连期间只更新名单，不产生进出的系统消息
		if (userName) {
			rd.knownUserNames = rd.knownUserNames || new Set();
			rd.knownUserNames.add(userName);
		}
		rd.knownUserIds.add(user.clientId);
		return
	}
	rd.knownUserNames = rd.knownUserNames || new Set();
	const isNew = userName
		? !rd.knownUserNames.has(userName)
		: !rd.knownUserIds.has(user.clientId);
	if (isNew) {
		rd.knownUserIds.add(user.clientId);
		if (userName) rd.knownUserNames.add(userName);
		const msg = `${displayName} ${t('system.joined', 'joined the conversation')}`;
		rd.messages.push({
			type: 'system',
			text: msg
		});
		if (activeRoomIndex === idx) addSystemMsg(msg, true);
		if (window.notifyMessage) {
			window.notifyMessage(rd.roomName, 'system', msg)
		}
	}
}

// 成员从列表中消失后延迟确认，避免重连换 id 被误判成离开
function scheduleClientLeft(idx, user) {
	const rd = roomsData[idx];
	if (!rd) return;
	const clientId = user && user.clientId;
	if (!clientId) return;

	rd.pendingLeft = rd.pendingLeft || new Map();
	if (rd.pendingLeft.has(clientId)) return;

	const entry = {
		name: nameOfUser(user),
		timer: setTimeout(() => {
			rd.pendingLeft.delete(clientId);
			// 到期再确认一次：同名的人（可能是新连接）已经回到名单就不算离开
			const stillGone = entry.name
				? !(rd.userList || []).some(u => nameOfUser(u) === entry.name)
				: !(rd.userList || []).some(u => u.clientId === clientId);
			if (!stillGone) return;
			// 名字已经不在 userMap 里，补回去让离开提示能显示正确的人
			if (!rd.userMap[clientId]) rd.userMap[clientId] = user;
			handleClientLeft(idx, clientId);
		}, LEAVE_CONFIRM_MS)
	};

	rd.pendingLeft.set(clientId, entry);
}

// Handle client left event
// 处理客户端离开事件
export function handleClientLeft(idx, clientId) {
	const rd = roomsData[idx];
	if (!rd) return;
	if (rd.privateChatTargetId === clientId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null;
		if (activeRoomIndex === idx) {
			updateChatInputStyle()
		}
	}
	const user = rd.userMap[clientId];
	const name = user ? (user.userName || user.username || user.name || 'Anonymous') : 'Anonymous';
	const msg = `${name} ${t('system.left', 'left the conversation')}`;
	rd.messages.push({
		type: 'system',
		text: msg
	});
	if (activeRoomIndex === idx) addSystemMsg(msg, true);
	rd.userList = rd.userList.filter(u => u.clientId !== clientId);
	delete rd.userMap[clientId];
	// 确认离开后清掉已知名单，同一账号之后重新进来才会提示加入
	const userName = nameOfUser(user);
	if (userName && rd.knownUserNames) rd.knownUserNames.delete(userName);
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
}

// Handle client message event
// 处理客户端消息事件
export function handleClientMessage(idx, msg) {
	const newRd = roomsData[idx];
	if (!newRd) return;

	// Prevent processing own messages unless it's a private message sent to oneself
	if (msg.clientId === newRd.myId && msg.userName === newRd.myUserName && !msg.type.includes('_private')) {
		return;
	}

	let msgType = msg.type || 'text';

	// Handle file messages
	if (msgType.startsWith('file_')) {
		// Part 1: Update message history and send notifications (for 'file_start' type)
		if (msgType === 'file_start' || msgType === 'file_start_private') {
			let realUserName = msg.userName;
			if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
				realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
			}
			const historyMsgType = msgType === 'file_start_private' ? 'file_private' : 'file';
			
			const fileId = msg.data && msg.data.fileId;
			if (fileId) { // Only proceed if we have a fileId
				const messageAlreadyInHistory = newRd.messages.some(
					m => m.msgType === historyMsgType && m.text && m.text.fileId === fileId && m.userName === realUserName
				);

				if (!messageAlreadyInHistory) {
					newRd.messages.push({
						type: 'other',
						text: msg.data, // This is the file metadata object
						userName: realUserName,
						avatar: realUserName,
						msgType: historyMsgType,
						timestamp: (msg.data && msg.data.timestamp) || Date.now() 
					});
				}
			}

			const notificationMsgType = msgType.includes('_private') ? 'private file' : 'file';
			if (window.notifyMessage && msg.data && msg.data.fileName) {
				window.notifyMessage(newRd.roomName, notificationMsgType, `${msg.data.fileName}`, realUserName);
			}
		}

		// Part 2: Handle UI interaction (rendering in active room, or unread count in inactive room)
		const incomingFileId = msg.data && msg.data.fileId;
		const trackingThisFile = incomingFileId ? window.fileTransfers.has(incomingFileId) : false;

		// 分卷必须持续累积，否则切换房间期间的缺卷会让传输永远停在中途
		if (activeRoomIndex === idx || trackingThisFile) {
			if (window.handleFileMessage) {
				window.handleFileMessage(msg.data, msgType.includes('_private'), newRd.chat);
			}
		}

		if (activeRoomIndex !== idx) {
			// If it's not the active room, only increment unread count for 'file_start' messages.
			if (msgType === 'file_start' || msgType === 'file_start_private') {
				newRd.unreadCount = (newRd.unreadCount || 0) + 1;
				renderRooms(activeRoomIndex);
			}
		}
		return; // File messages are fully handled.
	}

	// Handle image messages (both new and legacy formats)
	if (msgType === 'image' || msgType === 'image_private') {
		// Already has correct type
	} else if (!msgType.includes('_private')) {
		// Handle legacy image detection
		if (msg.data && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
			msgType = 'image';
		} else if (msg.data && typeof msg.data === 'object' && msg.data.image) {
			msgType = 'image';
		}
	}
	let realUserName = msg.userName;
	if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
		realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
	}

	// Add message to messages array for chat history
	roomsData[idx].messages.push({
		type: 'other',
		text: msg.data,
		userName: realUserName,
		avatar: realUserName,
		msgType: msgType,
		timestamp: Date.now()
	});

	// Only add message to chat display if it's for the active room
	if (activeRoomIndex === idx) {
		if (window.addOtherMsg) {
			window.addOtherMsg(msg.data, realUserName, realUserName, false, msgType);
		}
	} else {
		roomsData[idx].unreadCount = (roomsData[idx].unreadCount || 0) + 1;
		renderRooms(activeRoomIndex);
	}

	const notificationMsgType = msgType.includes('_private') ? `private ${msgType.split('_')[0]}` : msgType;
	if (window.notifyMessage) {
		window.notifyMessage(newRd.roomName, notificationMsgType, msg.data, realUserName);
	}
}

// Toggle private chat with a user
// 切换与某用户的私聊
export function togglePrivateChat(targetId, targetName) {
	const rd = roomsData[activeRoomIndex];
	if (!rd) return;
	if (rd.privateChatTargetId === targetId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null
	} else {
		rd.privateChatTargetId = targetId;
		rd.privateChatTargetName = targetName
	}
	renderUserList();
	updateChatInputStyle()
}


// Exit the current room
// 退出当前房间
export function exitRoom() {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const chatInst = roomsData[activeRoomIndex].chat;
		if (chatInst && typeof chatInst.destruct === 'function') {
			chatInst.destruct()
		} else if (chatInst && typeof chatInst.disconnect === 'function') {
			chatInst.disconnect()
		}
		roomsData[activeRoomIndex].chat = null;
		roomsData.splice(activeRoomIndex, 1);
		if (roomsData.length > 0) {
			switchRoom(0);
			return true
		} else {
			return false
		}
	}
	return false
}

export { roomsData, activeRoomIndex };

// Listen for sidebar username update event
// 监听侧边栏用户名更新事件
window.addEventListener('updateSidebarUsername', () => {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const rd = roomsData[activeRoomIndex];
		const sidebarUsername = document.getElementById('sidebar-username');
		if (sidebarUsername && rd.myUserName) {
			sidebarUsername.textContent = rd.myUserName;
		}
		// Also update the avatar to ensure consistency
		if (rd.myUserName) {
			setSidebarAvatar(rd.myUserName);
		}
	}
});