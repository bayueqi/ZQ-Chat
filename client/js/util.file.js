// Import necessary modules
// 导入必要的模块
import { deflate, inflate } from 'fflate';
import { showFileUploadModal } from './util.fileUpload.js';

// 分卷大小统一配置
const DEFAULT_VOLUME_SIZE = 256 * 1024; // 256KB 原始数据，编码并加密后单卷约 460KB

// 未写入连接的字节数超过此值时暂停发送。不设上限时大文件会把几百兆数据
// 堆在发送缓冲区里，心跳和数据控制消息排在后面，连接被判定超时后重连。
const MAX_BUFFERED_BYTES = 6 * 1024 * 1024;
// 接收端向发送端请求补发的最大轮数
const MAX_NACK_ATTEMPTS = 3;
// 分卷中断多久后判定为缺卷并请求补发
const STALL_TIMEOUT_MS = 15000;
// 请求补发持续多久仍不完整则放弃
const NACK_GIVEUP_MS = 300000;
// 发送完毕后等待对方确认收齐的超时
const ACK_TIMEOUT_MS = 90000;
// 连续无法写入连接多久后中止本次传输
const SEND_ABORT_MS = 120000;
// 超过这个大小的单文件不再压缩，直接分卷发送
const COMPRESS_SKIP_BYTES = 8 * 1024 * 1024;
// 接收端每收到多少卷回传一次进度
const PROGRESS_ACK_EVERY = 8;
// 发送端最多领先接收端多少卷。接收端处理不过来时，它只能排队解密，
// 期间发出的任何消息（文字、成员进出、确认）都排在几百兆数据后面，
// 看起来就是对方根本没收到
const SEND_WINDOW_VOLUMES = 16;
// 超过这个时间没有收到进度回报就不再限制领先量，避免对方不回消息时卡死
const PEER_PROGRESS_STALE_MS = 10000;

// File transfer state management
// 文件传输状态管理
window.fileTransfers = new Map();

// 当前房间的加密连接，由 room.js 注册
function getActiveChat() {
	return (typeof window.getActiveChat === 'function' ? window.getActiveChat() : null);
}

// 连接可用且发送缓冲区未堆积时才允许写入
function isChatWritable(chat) {
	if (!chat || !chat.isOpen()) return false;
	const connection = chat.connection;
	return !(connection && connection.bufferedAmount > MAX_BUFFERED_BYTES);
}

// 发送文件控制消息（确认收齐、请求补发）
function sendFileControl(message, chat) {
	const target = chat || getActiveChat();
	if (!target || !target.isOpen()) return false;
	return target.sendChannelMessage(message.type, message) !== false;
}

// Base64 encoding for binary data (more efficient than hex)
// Base64编码用于二进制数据（比十六进制更高效）
function arrayBufferToBase64(buffer) {
	const uint8Array = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return btoa(binary);
}

// Base64 decoding back to binary
// Base64解码回二进制数据
function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const uint8Array = new Uint8Array(binary.length);
	
	for (let i = 0; i < binary.length; i++) {
		uint8Array[i] = binary.charCodeAt(i);
	}
	
	return uint8Array;
}

// Generate unique file ID
// 生成唯一文件ID
function generateFileId() {
	return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Calculate SHA-256 hash for data integrity verification
// 计算SHA-256哈希值用于数据完整性验证
async function calculateHash(data) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



// Compress file into volumes with optimized compression
// 将文件压缩为分卷，优化压缩算法
async function compressFileToVolumes(file, volumeSize = DEFAULT_VOLUME_SIZE) { // 96KB原始数据，base64后约128KB
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = async function(e) {
			const arrayBuffer = new Uint8Array(e.target.result);
			
			try {
				// Calculate hash of original file for integrity
				const originalHash = await calculateHash(arrayBuffer);

				const split = (payload, didCompress) => {
					const volumes = [];
					for (let i = 0; i < payload.length; i += volumeSize) {
						const volume = payload.slice(i, i + volumeSize);
						volumes.push(arrayBufferToBase64(volume));
					}
					resolve({
						volumes,
						originalSize: file.size,
						compressedSize: payload.length,
						originalHash,
						compressed: didCompress
					});
				};

				// 大文件不压缩：视频、图片、压缩包本身没有压缩空间，
				// 整份过一遍 deflate 只会让发送端和接收端各卡住十几秒
				if (arrayBuffer.length > COMPRESS_SKIP_BYTES) {
					split(arrayBuffer, false);
					return;
				}

				// Use single compression pass with balanced compression
				// 使用单次压缩，平衡压缩率和速度
				deflate(arrayBuffer, { 
					level: 6, // 平衡压缩级别
					mem: 8    // 合理内存使用
				}, (err, compressed) => {
					if (err) {
						reject(err);
						return;
					}
					split(compressed, true);
				});
			} catch (hashError) {
				reject(hashError);
			}
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Compress multiple files into a single archive with volumes
// 将多个文件压缩为单个分卷归档
async function compressFilesToArchive(files, volumeSize = DEFAULT_VOLUME_SIZE) {	try {
		// Create a simple archive format: [file1_size][file1_name_length][file1_name][file1_data][file2_size]...
		// 创建简单的归档格式
		const archiveData = [];
		const fileManifest = [];
		
		for (const file of files) {
			const fileBuffer = await readFileAsArrayBuffer(file);
			const nameBytes = new TextEncoder().encode(file.name);
			
			// Add file metadata to manifest
			fileManifest.push({
				name: file.name,
				size: file.size,
				offset: 0 // Will be calculated later
			});
			
			// File format: [name_length(4)][name][size(8)][data]
			// Use separate arrays to avoid alignment issues
			const nameLengthBytes = new Uint8Array(4);
			const nameLengthView = new DataView(nameLengthBytes.buffer);
			nameLengthView.setUint32(0, nameBytes.length, true); // little endian
			
			const fileSizeBytes = new Uint8Array(8);
			const fileSizeView = new DataView(fileSizeBytes.buffer);
			fileSizeView.setBigUint64(0, BigInt(file.size), true); // little endian
			
			archiveData.push(
				nameLengthBytes,
				nameBytes,
				fileSizeBytes,
				new Uint8Array(fileBuffer)
			);
		}		
		// Combine all data
		const totalLength = archiveData.reduce((sum, part) => sum + part.length, 0);
		
		const combinedData = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const part of archiveData) {
			combinedData.set(part, offset);
			offset += part.length;
		}
		
		// Calculate hash of the entire archive
		const archiveHash = await calculateHash(combinedData);
		
		// Compress the archive
		return new Promise((resolve, reject) => {
			deflate(combinedData, { 
				level: 6,
				mem: 8
			}, (err, compressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Split compressed data into volumes
				const volumes = [];
				for (let i = 0; i < compressed.length; i += volumeSize) {
					const volume = compressed.slice(i, i + volumeSize);
					volumes.push(arrayBufferToBase64(volume));
				}
				
				resolve({
					volumes,
					originalSize: totalLength,
					compressedSize: compressed.length,
					archiveHash,
					fileCount: files.length,
					fileManifest
				});
			});
		});
	} catch (error) {
		throw new Error(`Archive compression failed: ${error.message}`);
	}
}

// Helper function to read file as array buffer
// 辅助函数：将文件读取为ArrayBuffer
function readFileAsArrayBuffer(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve(e.target.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Decompress volumes back to file
// 将分卷解压回文件
async function decompressVolumesToFile(volumes, fileName, originalHash = null, compressedMode = true) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const data = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const item of combinedData) {
			data.set(item, offset);
			offset += item.length;
		}

		const save = async (bytes) => {
			// Verify hash if provided
			if (originalHash) {
				const calculatedHash = await calculateHash(bytes);
				if (calculatedHash !== originalHash) {
					throw new Error('File integrity check failed: hash mismatch');
				}
			}

			// Create blob and download
			const blob = new Blob([bytes]);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		};

		// 发送端没有压缩时直接落盘，省掉一次整文件的 inflate
		if (!compressedMode) {
			await save(data);
			return;
		}

		// Decompress
		return new Promise((resolve, reject) => {
			inflate(data, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				try {
					await save(decompressed);
					resolve();
				} catch (hashError) {
					reject(hashError);
				}
			});
		});
	} catch (error) {
		console.error('Decompression error:', error);
		throw error;
	}
}

// Decompress archive volumes to multiple files
// 将归档分卷解压为多个文件
async function decompressArchiveToFiles(volumes, fileManifest, archiveHash = null) {
	try {
		// Combine all volumes using base64 decoding
		const combinedData = volumes.map(volume => {
			return base64ToArrayBuffer(volume);
		});
		
		const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
		const compressed = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const data of combinedData) {
			compressed.set(data, offset);
			offset += data.length;
		}
		
		// Decompress archive
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify archive hash if provided
				if (archiveHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== archiveHash) {
							reject(new Error('Archive integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('Archive integrity check failed: ' + hashError.message));
						return;
					}
				}
						// Extract files from archive
				let dataOffset = 0;
				const extractedFiles = [];
						for (const fileInfo of fileManifest) {
					// Read file metadata: [name_length(4)][name][size(8)][data]
					const nameLengthBytes = decompressed.slice(dataOffset, dataOffset + 4);
					const nameLengthView = new DataView(nameLengthBytes.buffer);
					const nameLength = nameLengthView.getUint32(0, true); // little endian
					dataOffset += 4;
					
					const nameBytes = decompressed.slice(dataOffset, dataOffset + nameLength);
					const fileName = new TextDecoder().decode(nameBytes);
					dataOffset += nameLength;
					
					// Use DataView to read BigUint64 safely
					const fileSizeBytes = decompressed.slice(dataOffset, dataOffset + 8);
					const fileSizeView = new DataView(fileSizeBytes.buffer);
					const fileSize = Number(fileSizeView.getBigUint64(0, true)); // little endian
					dataOffset += 8;
					
					const fileData = decompressed.slice(dataOffset, dataOffset + fileSize);
					dataOffset += fileSize;
					
					// Create and download file
					const blob = new Blob([fileData]);
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
					
					extractedFiles.push(fileName);
					
					// Add small delay between downloads to avoid overwhelming the browser
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				
				resolve(extractedFiles);
			});
		});
	} catch (error) {
		console.error('Archive decompression error:', error);
		throw error;
	}
}

// Setup file sending functionality
// 设置文件发送功能
export function setupFileSend({
	inputSelector,
	attachBtnSelector,
	fileInputSelector,
	onSend
}) {
	const attachBtn = document.querySelector(attachBtnSelector);
	
	if (attachBtn) {
		// 点击附件按钮显示文件上传模态框
		// Click attach button to show file upload modal
		attachBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			showFileUploadModal(async (files) => {
				// 发起时锁定目标房间，压缩大文件期间切换到其他房间也不会发错
				const targetRoom = (typeof window.getActiveRoomData === 'function' ? window.getActiveRoomData() : null);
				const userName = targetRoom ? (targetRoom.myUserName || '') : '';
				await handleFilesUpload(files, (msg) => {
					// 合并 userName 字段，并回传是否真正写入连接
					return onSend({ ...msg, userName }, targetRoom);
				}, targetRoom && targetRoom.chat ? targetRoom.chat : null);
			});
		});
	}
}

// Handle files upload
// 处理文件上传
async function handleFilesUpload(files, onSend, chat = null) {
	if (!files || files.length === 0) return;

	// 文件开始消息决定接收端是否建立传输，发不出去的话后面所有分卷都会被丢弃
	const sendStart = async (payload) => {
		const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
		const deadline = Date.now() + SEND_ABORT_MS;
		while (Date.now() < deadline) {
			if (isChatWritable(chat) && onSend(payload) !== false) return true;
			await sleep(200);
		}
		return false;
	};

	const abortUpload = (label) => {
		if (window.addSystemMsg) {
			window.addSystemMsg(`Failed to send ${label}: no recipient available`);
		}
	};
	
	const fileId = generateFileId();
	
	try {
		// Show compression progress
		let progressElement = null;
		
		function showProgress(message) {
			// 删除系统提示
		}
		
		function updateProgress(message) {
			// 删除系统提示
		}
		
		if (files.length === 1) {
			// Single file upload
			const file = files[0];
			showProgress();
			
			const { volumes, originalSize, compressedSize, originalHash, compressed } = await compressFileToVolumes(file);
			
			updateProgress();
			
			// Create file transfer state
			const fileTransfer = {
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				compressed,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				originalHash,
				chat
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// Send file start message
			const started = await sendStart({
				type: 'file_start',
				fileId,
				fileName: file.name,
				originalSize,
				compressedSize,
				compressed,
				totalVolumes: volumes.length,
				originalHash
			});
			if (!started) {
				abortUpload(file.name);
				window.fileTransfers.delete(fileId);
				return;
			}
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, file.name);
			
		} else {
			// Multiple files upload - create archive
			const totalSize = files.reduce((sum, file) => sum + file.size, 0);
			showProgress();
			
			const { volumes, originalSize, compressedSize, archiveHash, fileCount, fileManifest } = await compressFilesToArchive(files);
			
			updateProgress();
			
			// Create file transfer state for archive
			const fileTransfer = {
				fileId,
				fileName: `${files.length} files.zip`, // Virtual archive name
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true,
				chat
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// Send archive start message
			const started = await sendStart({
				type: 'file_start',
				fileId,
				fileName: `${files.length} files`,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true
			});
			if (!started) {
				abortUpload(`${files.length} files`);
				window.fileTransfers.delete(fileId);
				return;
			}
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, `${files.length} files`);
		}
		
	} catch (error) {
		console.error('File compression error:', error);
		if (window.addSystemMsg) {
			window.addSystemMsg(`Failed to compress files: ${error.message}`);
		}
	}
}

// Send volumes with progress tracking
// 发送分卷并跟踪进度
async function sendVolumes(fileId, volumes, onSend, updateProgress, fileName) {
	const fileTransfer = window.fileTransfers.get(fileId);
	if (!fileTransfer) return;

	// 保留分卷引用，接收端缺卷时按需补发
	fileTransfer.volumes = volumes;

	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
	const total = volumes.length;

	// 绑定发起时的连接，期间切换房间也不会写到别的房间去
	const chat = fileTransfer.chat || getActiveChat();
	const canWrite = () => isChatWritable(chat);

	// 单卷发送，返回是否真正写入连接
	const writeVolume = (index) => onSend({
		type: 'file_volume',
		fileId,
		volumeIndex: index,
		volumeData: volumes[index],
		isLast: index === total - 1
	}) !== false;

	const finish = () => {
		fileTransfer.sendDone = true;
		onSend({ type: 'file_complete', fileId });
		// 数据已全部发出，等接收端回 file_ack 再收尾
		fileTransfer.status = 'sent';
		updateFileProgress(fileId);
		updateProgress(`✓ Sent ${fileName} successfully`);
		setTimeout(() => {
			const transfer = window.fileTransfers.get(fileId);
			if (transfer && transfer.status === 'sent') {
				transfer.status = 'completed';
				updateFileProgress(fileId);
			}
		}, ACK_TIMEOUT_MS);
	};

	// 接收端报告缺卷时补发，主循环进行中也要响应（连接抖动会丢在途分卷）
	fileTransfer.resend = async (indices) => {
		for (const index of indices) {
			if (!Number.isInteger(index) || index < 0 || index >= total) continue;
			while (!canWrite()) await sleep(200);
			while (!writeVolume(index)) await sleep(200);
			await sleep(0);
		}
		// 补发期间主循环还未结束的话，完成消息由主循环负责发出
		if (fileTransfer.sendDone) {
			onSend({ type: 'file_complete', fileId });
		}
	};

	let currentVolume = 0;
	let stalledSince = 0;

	// 每批 10 卷、间隔 100ms。更快会把服务端转发队列灌满，
	// 连接被中途断开后重连，整体反而更慢
	const BATCH_SIZE = 10;
	const BATCH_DELAY_MS = 100;

	while (currentVolume < total) {
		let moved = 0;
		let waitPeer = false;
		while (moved < BATCH_SIZE && currentVolume < total) {
			// 接收端还没处理到的分卷太多就先停手。一直猛发会把对方的
			// 消息队列堆到几百兆，期间所有消息都收不到
			if (fileTransfer.peerProgressAt && Date.now() - fileTransfer.peerProgressAt < PEER_PROGRESS_STALE_MS) {
				const ahead = currentVolume - (fileTransfer.peerReceived || 0);
				if (ahead >= SEND_WINDOW_VOLUMES) {
					waitPeer = true;
					break;
				}
			}
			// 连接断开、缓冲区堆积、对方尚未完成密钥交换时停在当前位置，
			// 不跳过、不计入已发送，等连接恢复后从这一卷继续
			const sent = canWrite() ? writeVolume(currentVolume) : false;
			if (!sent) break;
			currentVolume++;
			moved++;
		}

		if (moved === 0) {
			// 等接收端追上，不算发送失败
			if (waitPeer) {
				stalledSince = 0;
				await sleep(30);
				continue;
			}
			if (!stalledSince) stalledSince = Date.now();
			// 长时间无法写入说明对端不存在或连接始终没有恢复，中止并提示
			if (Date.now() - stalledSince > SEND_ABORT_MS) {
				if (window.addSystemMsg) {
					window.addSystemMsg(`File transfer aborted: no recipient available (${currentVolume}/${total} sent)`);
				}
				fileTransfer.status = 'completed';
				updateFileProgress(fileId);
				return;
			}
			await sleep(200);
			continue;
		}

		stalledSince = 0;
		fileTransfer.sentVolumes = currentVolume;
		updateFileProgress(fileId);
		await sleep(BATCH_DELAY_MS);
	}

	finish();
}

// Update file progress in chat
// 更新聊天中的文件进度
function updateFileProgress(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) return;
	const elements = document.querySelectorAll(`[data-file-id="${fileId}"]`);
	elements.forEach(element => {
		const progressContainer = element.querySelector('.file-progress-container');
		const progressBar = element.querySelector('.file-progress');
		const statusText = element.querySelector('.file-status');
		const downloadBtn = element.querySelector('.file-download-btn');
		
		// 判断是否为发送方（发送方没有volumeData）
		const isSender = !transfer.volumeData || transfer.volumeData.length === 0;
		
		if (transfer.status === 'sending') {
			// 发送端按对方已收到的卷数显示，两边数字保持一致；
			// 还没有进度回报时退回到本地已写入的卷数
			const shown = Number.isInteger(transfer.peerReceived)
				? Math.min(transfer.peerReceived, transfer.sentVolumes)
				: transfer.sentVolumes;
			const progress = (shown / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Sending ${shown}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'receiving') {
			const progress = (transfer.receivedVolumes.size / transfer.totalVolumes) * 100;
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = `${progress}%`;
			if (statusText) statusText.textContent = `Receiving ${transfer.receivedVolumes.size}/${transfer.totalVolumes}`;
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'sent') {
			// 数据已发出，等接收端确认收齐
			if (progressContainer) {
				progressContainer.style.display = 'block';
				progressContainer.classList.remove('fade-out');
			}
			if (progressBar) progressBar.style.width = '100%';
			if (statusText) statusText.textContent = 'Waiting for receiver';
			if (downloadBtn) {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none';
			}
		} else if (transfer.status === 'completed') {
			// 传输完成时的动画序列
			if (progressContainer) {
				// 先添加淡出动画类
				progressContainer.classList.add('fade-out');
				// 延迟后完全隐藏
				setTimeout(() => {
					progressContainer.style.display = 'none';
				}, 400);
			}
			
			if (downloadBtn) {
				// 只有接收方才显示下载按钮
				if (isSender) {
					downloadBtn.classList.remove('show', 'animate-in');
					downloadBtn.style.display = 'none';
				} else {
					// 延迟显示下载按钮，等进度条消失动画完成
					setTimeout(() => {
						downloadBtn.style.display = 'flex';
						downloadBtn.classList.add('show');
						downloadBtn.disabled = false;
						// 添加进入动画
						setTimeout(() => {
							downloadBtn.classList.add('animate-in');
						}, 50);
						// 清理动画类
						setTimeout(() => {
							downloadBtn.classList.remove('animate-in');
						}, 550);
					}, 200);
				}
			}
		}
	});
}

// Handle incoming file messages
// 处理接收到的文件消息
export function handleFileMessage(message, isPrivate = false, chat = null) {
	const { type, fileId, userName } = message;
	
	switch (type) {
		case 'file_start':
			handleFileStart(message, isPrivate, chat);
			break;
		case 'file_volume':
			handleFileVolume(message);
			break;
		case 'file_complete':
			handleFileComplete(message);
			break;
		case 'file_nack':
			handleFileNack(message);
			break;
		case 'file_ack':
			handleFileAck(message);
			break;
		case 'file_progress':
			handleFileProgress(message);
			break;
	}
}

// Handle receiver progress report
// 处理接收端回传的进度
function handleFileProgress(message) {
	const { fileId, received } = message;
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status !== 'sending' || !Number.isInteger(received)) return;
	transfer.peerReceived = received;
	transfer.peerProgressAt = Date.now();
	updateFileProgress(fileId);
}

// Handle file start message
// 处理文件开始消息
function handleFileStart(message, isPrivate, chat) {
	const { fileId, fileName, originalSize, compressedSize, totalVolumes, originalHash, archiveHash, fileCount, fileManifest, isArchive, userName } = message;

	// 开始消息可能因连接抖动重发，同一份文件只建立一次传输状态
	if (window.fileTransfers.has(fileId)) return;
	
	const fileTransfer = {
		fileId,
		fileName,
		originalSize,
		compressedSize,
		totalVolumes,
		receivedVolumes: new Set(),
		volumeData: new Array(totalVolumes),
		status: 'receiving',
		originalHash,
		archiveHash,
		// 老版本客户端不带这个字段，默认按压缩过处理
		compressed: message.compressed !== false,
		fileCount,
		fileManifest,
		isArchive,
		userName, // 记录发送者名字
		chat: chat || getActiveChat() // 回到这条消息所属房间的连接，用于确认收齐和请求补发
	};
	
	window.fileTransfers.set(fileId, fileTransfer);

	// 分卷中途中断（连接抖动、对端停止发送）时主动核对缺卷
	armStallTimer(fileId);

	// 添加文件消息到聊天
	if (window.addOtherMsg) {
		let displayData;
		if (isArchive) {
			displayData = {
				type: 'file',
				fileId,
				fileName: `${fileCount} files`,
				originalSize,
				totalVolumes,
				fileCount,
				isArchive: true,
				userName
			};
		} else {
			displayData = {
				type: 'file',
				fileId,
				fileName,
				originalSize,
				totalVolumes,
				userName
			};
		}
		
		window.addOtherMsg(displayData, userName, userName, false, isPrivate ? 'file_private' : 'file');
	}
}

// Handle file volume message
// 处理文件分卷消息
function handleFileVolume(message) {
	const { fileId, volumeIndex, volumeData } = message;
	const transfer = window.fileTransfers.get(fileId);

	if (!transfer || transfer.status === 'completed') return;

	transfer.receivedVolumes.add(volumeIndex);
	transfer.volumeData[volumeIndex] = volumeData;
	armStallTimer(fileId);

	if (transfer.receivedVolumes.size === transfer.totalVolumes) {
		finishReceive(fileId, transfer);
		return;
	}
	// 回传进度，发送端据此控制领先量，别把对方的消息队列堵住
	if ((transfer.receivedVolumes.size % PROGRESS_ACK_EVERY) === 0) {
		sendFileControl({
			type: 'file_progress',
			fileId,
			received: transfer.receivedVolumes.size
		}, transfer.chat);
	}
	// 大文件逐卷刷新会拖慢主线程，按间隔取样
	if (transfer.totalVolumes <= 10 || (transfer.receivedVolumes.size % 8) === 0) {
		updateFileProgress(fileId);
	}
}

// Handle file complete message
// 处理文件完成消息
function handleFileComplete(message) {
	const { fileId } = message;
	const transfer = window.fileTransfers.get(fileId);

	if (!transfer || transfer.status === 'completed') return;

	// 对端已声明发完，后续补发请求按次数限制
	transfer.doneSignaled = true;

	if (transfer.receivedVolumes.size === transfer.totalVolumes) {
		finishReceive(fileId, transfer);
		return;
	}
	// 对端已发完但本端仍有缺口：请求补发
	requestMissingVolumes(fileId, transfer, true);
}

// 接收端收齐：标记完成、通知发送端、清理计时器
function finishReceive(fileId, transfer) {
	if (transfer.status === 'completed') return;
	clearStallTimer(transfer);
	transfer.stallSince = 0;
	transfer.status = 'completed';
	updateFileProgress(fileId);
	sendFileControl({ type: 'file_ack', fileId }, transfer.chat);
}

// 记录最后一次收到分卷的时间，长时间无新数据时核对缺口
function armStallTimer(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status === 'completed') return;
	clearStallTimer(transfer);
	transfer.stallTimer = setTimeout(() => {
		transfer.stallTimer = null;
		const current = window.fileTransfers.get(fileId);
		if (!current || current.status === 'completed') return;
		if (current.receivedVolumes.size < current.totalVolumes) {
			requestMissingVolumes(fileId, current);
		}
	}, STALL_TIMEOUT_MS);
}

function clearStallTimer(transfer) {
	if (transfer && transfer.stallTimer) {
		clearTimeout(transfer.stallTimer);
		transfer.stallTimer = null;
	}
}

// 收集缺失分卷索引并向发送端请求补发
function requestMissingVolumes(fileId, transfer, fromComplete = false) {
	if (!transfer || transfer.status === 'completed') return;

	const missing = [];
	for (let i = 0; i < transfer.totalVolumes; i++) {
		if (!transfer.receivedVolumes.has(i)) missing.push(i);
	}
	if (missing.length === 0) {
		finishReceive(fileId, transfer);
		return;
	}

	// 从第一次发现缺口起计时，对端消失后不至于无限重试
	if (!transfer.stallSince) transfer.stallSince = Date.now();
	const giveUp = () => {
		if (window.addSystemMsg) {
			window.addSystemMsg(`File transfer incomplete: ${missing.length} of ${transfer.totalVolumes} parts missing`);
		}
		transfer.status = 'completed';
		updateFileProgress(fileId);
	};

	if (Date.now() - transfer.stallSince > NACK_GIVEUP_MS) {
		giveUp();
		return;
	}

	// 对方已声明发送完毕时，补发请求次数有限；传输途中的缺口可以反复探测
	if (fromComplete) {
		transfer.nackAttempts = (transfer.nackAttempts || 0) + 1;
		if (transfer.nackAttempts > MAX_NACK_ATTEMPTS) {
			giveUp();
			return;
		}
	}

	if (!sendFileControl({ type: 'file_nack', fileId, missing }, transfer.chat)) {
		// 连接尚未恢复，稍后再试，不计入补发次数
		setTimeout(() => requestMissingVolumes(fileId, transfer, fromComplete), 3000);
		return;
	}

	setTimeout(() => {
		const current = window.fileTransfers.get(fileId);
		if (current && current.status !== 'completed' && current.receivedVolumes.size < current.totalVolumes) {
			requestMissingVolumes(fileId, current, current.doneSignaled);
		}
	}, STALL_TIMEOUT_MS);
}

// 发送端收到补发请求，按索引重发
function handleFileNack(message) {
	const { fileId, missing } = message;
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || typeof transfer.resend !== 'function' || !Array.isArray(missing) || missing.length === 0) return;
	transfer.resend(missing);
}

// 发送端收到收齐确认，收尾并释放分卷引用
function handleFileAck(message) {
	const { fileId } = message;
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) return;
	if (transfer.status === 'sent' || transfer.status === 'sending') {
		transfer.status = 'completed';
		updateFileProgress(fileId);
	}
	transfer.volumes = null;
	transfer.resend = null;
}

// Download file from volumes
// 从分卷下载文件
export async function downloadFile(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.status !== 'completed') return;
	
	try {
		if (transfer.isArchive) {
			// Download archive as multiple files
			await decompressArchiveToFiles(transfer.volumeData, transfer.fileManifest, transfer.archiveHash);
			// 删除系统提示
		} else {
			// Download single file
			await decompressVolumesToFile(transfer.volumeData, transfer.fileName, transfer.originalHash, transfer.compressed !== false);
			// 删除系统提示
		}
	} catch (error) {
		console.error('Download error:', error);
		window.addSystemMsg(`Failed to download: ${error.message}`);
	}
}

// Format file size
// 格式化文件大小
export function formatFileSize(bytes) {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Legacy image send function for backward compatibility
// 向后兼容的图片发送函数
export function setupImageSend(config) {
	setupFileSend(config);
}