const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function detectImageType(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function cleanDisplayName(name, extension) {
  const fallback = `图片.${extension}`;
  const cleaned = path.basename(String(name || fallback)).replace(/[\r\n\t]/g, ' ').trim();
  return (cleaned || fallback).slice(0, 160);
}

function imageDirectory(storageRoot, options = {}) {
  return path.join(storageRoot, options.directoryName || 'images');
}

async function saveNoteImage(storageRoot, payload = {}, options = {}) {
  const bytes = Buffer.isBuffer(payload.bytes)
    ? payload.bytes
    : Buffer.from(payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : payload.bytes || []);
  if (!bytes.length) throw new Error('没有读取到图片内容。');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 25 MB。');

  const type = detectImageType(bytes);
  if (!type) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片。');

  const id = crypto.randomUUID();
  const directory = imageDirectory(storageRoot, options);
  const fileName = `${id}.${type.extension}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), bytes, { flag: 'wx' });
  return {
    id,
    fileName,
    name: cleanDisplayName(payload.name, type.extension),
    mimeType: type.mimeType,
    size: bytes.length,
    reference: `memokeep-image://${id}`
  };
}

async function readNoteImage(storageRoot, id, options = {}) {
  if (!IMAGE_ID_PATTERN.test(String(id || ''))) throw new Error('图片 ID 无效。');
  const directory = imageDirectory(storageRoot, options);
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const fileName = entries.find(entry => entry.startsWith(`${id}.`));
  if (!fileName) return null;
  const filePath = path.join(directory, fileName);
  const bytes = await fs.readFile(filePath);
  const type = detectImageType(bytes);
  if (!type) throw new Error('图片文件已损坏或格式不受支持。');
  return {
    id,
    fileName,
    mimeType: type.mimeType,
    size: bytes.length,
    dataUrl: `data:${type.mimeType};base64,${bytes.toString('base64')}`
  };
}

async function deleteNoteImage(storageRoot, id, options = {}) {
  if (!IMAGE_ID_PATTERN.test(String(id || ''))) throw new Error('图片 ID 无效。');
  const directory = imageDirectory(storageRoot, options);
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const fileName = entries.find(entry => entry.startsWith(`${id}.`));
  if (!fileName) return false;
  await fs.rm(path.join(directory, fileName), { force: true });
  return true;
}

module.exports = { MAX_IMAGE_BYTES, deleteNoteImage, detectImageType, readNoteImage, saveNoteImage };
