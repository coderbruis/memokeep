// Image layout lives in Quill formats, so edits participate in history and saving.
function noteImageLayout(image) {
  const dimension = value => /^\d+$/.test(String(value || '')) && Number(value) > 0 && Number(value) <= 32768 ? Number(value) : 0;
  return {
    width: dimension(image.getAttribute('width')),
    height: dimension(image.getAttribute('height')),
    rotation: [90, 180, 270].includes(Number(image.dataset.imageRotation)) ? Number(image.dataset.imageRotation) : 0,
    ...(image.dataset.imageWrap === 'left' ? { wrap: 'left' } : {})
  };
}

function writeNoteImageLayout(image, layout = {}) {
  const source = document.createElement('img');
  source.setAttribute('width', layout.width || '');
  source.setAttribute('height', layout.height || '');
  source.dataset.imageRotation = layout.rotation || 0;
  if (layout.wrap === 'left') source.dataset.imageWrap = 'left';
  const clean = noteImageLayout(source);
  for (const name of ['width', 'height']) {
    if (clean[name]) image.setAttribute(name, clean[name]);
    else image.removeAttribute(name);
  }
  if (clean.rotation) image.dataset.imageRotation = clean.rotation;
  else delete image.dataset.imageRotation;
  if (clean.wrap) image.dataset.imageWrap = clean.wrap;
  else delete image.dataset.imageWrap;
}

function noteImageDimensions(image) {
  const layout = noteImageLayout(image);
  const sideways = layout.rotation % 180 !== 0;
  const naturalWidth = (sideways ? image.naturalHeight : image.naturalWidth) || 300;
  const naturalHeight = (sideways ? image.naturalWidth : image.naturalHeight) || 200;
  const fit = Math.min(1, 720 / naturalWidth, 520 / naturalHeight);
  const width = layout.width || (layout.height ? layout.height * naturalWidth / naturalHeight : naturalWidth * fit);
  const height = layout.height || width * naturalHeight / naturalWidth;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), naturalWidth, naturalHeight, rotation: layout.rotation };
}

function paintNoteImage(frame) {
  const image = frame.querySelector('img');
  if (!image) return;
  const { width, height, rotation } = noteImageDimensions(image);
  if (noteImageLayout(image).wrap) frame.dataset.imageWrap = 'left';
  else delete frame.dataset.imageWrap;
  const sideways = rotation % 180 !== 0;
  frame.style.width = `${width}px`;
  frame.style.aspectRatio = `${width} / ${height}`;
  image.style.width = `${sideways ? height / width * 100 : 100}%`;
  image.style.height = `${sideways ? width / height * 100 : 100}%`;
  image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
}

function prepareNoteImagePreview(source, image) {
  const size = noteImageDimensions(source);
  writeNoteImageLayout(image, { width: size.naturalWidth, height: size.naturalHeight, rotation: size.rotation });
  paintNoteImage(image.closest('.note-image-frame'));
}

function noteImageFormats(image) {
  const formats = {};
  if (image.alt) formats.alt = image.alt;
  if (image.dataset.memokeepImageId) formats.imageId = image.dataset.memokeepImageId;
  if (image.dataset.fileName) formats.imageName = image.dataset.fileName;
  const layout = noteImageLayout(image);
  if (layout.width || layout.height || layout.rotation || layout.wrap) formats.imageLayout = layout;
  return formats;
}

function createNoteImageRegistry(Quill, formats) {
  // Keep the memo editor's standard image format independent of note images.
  const registry = new (Quill.import('parchment').Registry)();
  const core = ['block', 'break', 'cursor', 'inline', 'scroll', 'text'];
  for (const name of [...core, ...formats]) {
    let format = Quill.import(`${core.includes(name) ? 'blots' : 'formats'}/${name}`);
    while (format) { registry.register(format); format = format.requiredContainer; }
  }
  const Embed = Quill.import('blots/embed');
  const BaseImage = Quill.import('formats/image');
  class NoteImage extends Embed {
    static blotName = 'image';
    static tagName = 'SPAN';
    static className = 'note-image-frame';
    static create(value) {
      const frame = super.create();
      frame.tabIndex = 0;
      frame.setAttribute('aria-label', '图片，Shift+F10 打开图片操作，Enter 预览');
      const image = document.createElement('img');
      image.src = BaseImage.sanitize(value);
      image.draggable = false;
      frame.append(image);
      return frame;
    }
    constructor(scroll, node) {
      super(scroll, node);
      this.image = node.querySelector('img');
      this.image.addEventListener('load', () => paintNoteImage(node));
      paintNoteImage(node);
    }
    // Resolve the editor caret to a text guard instead of the whole image box.
    position(index) { return index > 0 ? [this.rightGuard, 1] : [this.leftGuard, 0]; }
    static value(node) { return node.querySelector('img').getAttribute('src'); }
    static formats(node) { return noteImageFormats(node.querySelector('img')); }
    format(name, value) {
      if (name === 'imageLayout') {
        writeNoteImageLayout(this.image, value || {});
        paintNoteImage(this.domNode);
      } else if (['alt', 'imageId', 'imageName'].includes(name)) {
        const attribute = { alt: 'alt', imageId: 'data-memokeep-image-id', imageName: 'data-file-name' }[name];
        if (value) this.image.setAttribute(attribute, value);
        else this.image.removeAttribute(attribute);
      } else super.format(name, value);
    }
    html() { return this.image.cloneNode().outerHTML; }
  }
  registry.register(NoteImage);
  registerNoteTableWidths(Quill, registry);
  return registry;
}

// Export rendered pixels so other applications can paste the image directly.
// 有时 image.decode() / navigator.clipboard.write 不返回，复制按钮就一直灰着；每一步都限时。
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function copyNoteImageToClipboard(image) {
  try {
    const desktopCopy = window.memoKeepDesktop?.copyImageToClipboard;
    if (!desktopCopy && (!navigator.clipboard?.write || typeof ClipboardItem !== 'function')) throw new Error('Clipboard unavailable');
    if (!image.complete || !image.naturalWidth) await withTimeout(image.decode(), 5000, 'Image decode timed out');
    const { naturalWidth, naturalHeight, rotation } = noteImageDimensions(image);
    const canvas = document.createElement('canvas');
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const context = canvas.getContext('2d');
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    const blob = await withTimeout(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), 10000, 'Image conversion timed out');
    if (!blob) throw new Error('Image conversion failed');
    if (desktopCopy) await withTimeout(desktopCopy(new Uint8Array(await blob.arrayBuffer())), 10000, 'Clipboard timed out');
    else await withTimeout(navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]), 10000, 'Clipboard timed out');
    showToast('图片已复制');
    return true;
  } catch (error) {
    console.warn('Image copy failed:', error?.message || error);
    showToast('图片复制失败，请确认图片已加载后重试', true);
    return false;
  }
}

function bindNoteImagePreview(lightbox) {
  const image = lightbox.querySelector('#noteImageLightboxImage');
  const frame = image.closest('.note-image-frame');
  const viewport = lightbox.querySelector('.note-image-preview-viewport');
  const output = lightbox.querySelector('[data-image-zoom-value]');
  const controller = new AbortController();
  const listen = (node, type, callback, options = {}) => node.addEventListener(type, callback, { ...options, signal: controller.signal });
  let scale = 1, x = 0, y = 0, drag = null;
  const paint = () => {
    frame.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
    output.textContent = `${Math.round(scale * 100)}%`;
    lightbox.querySelector('[data-image-zoom="out"]').disabled = scale <= .05;
    lightbox.querySelector('[data-image-zoom="in"]').disabled = scale >= 8;
  };
  const reset = () => {
    if (lightbox.classList.contains('hidden')) return;
    const size = noteImageDimensions(image);
    scale = Math.max(.05, Math.min(1, (viewport.clientWidth - 32) / size.width, (viewport.clientHeight - 32) / size.height));
    x = y = 0; paint();
  };
  const zoom = value => {
    const next = Math.max(.05, Math.min(8, value));
    x *= next / scale; y *= next / scale; scale = next; paint();
  };
  listen(lightbox, 'click', event => {
    const action = event.target.closest('[data-image-zoom]')?.dataset.imageZoom;
    if (action === 'in') zoom(scale * 1.25);
    if (action === 'out') zoom(scale / 1.25);
    if (action === 'actual') { x = y = 0; zoom(1); }
    if (action === 'fit') reset();
  });
  listen(viewport, 'wheel', event => { event.preventDefault(); zoom(scale * Math.exp(-event.deltaY * .002)); }, { passive: false });
  listen(viewport, 'pointerdown', event => {
    if (event.button !== 0 || !event.target.closest('.note-image-frame')) return;
    event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('is-dragging');
  });
  listen(viewport, 'pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    x += event.clientX - drag.x; y += event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY; paint();
  });
  listen(viewport, 'lostpointercapture', () => { drag = null; viewport.classList.remove('is-dragging'); });
  listen(lightbox, 'keydown', event => {
    if (event.key === 'Tab') {
      const buttons = [...lightbox.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') reset(); else zoom(scale * (event.key === '-' ? .8 : 1.25));
    }
  });
  image.draggable = false;
  listen(image, 'load', reset);
  listen(window, 'resize', reset);
  document.body.append(lightbox);
  return { reset, dispose() { controller.abort(); lightbox.remove(); } };
}

function registerNoteImageClipboard(quill) {
  const Delta = window.Quill.import('delta');
  quill.clipboard.addMatcher('IMG', image => new Delta().insert({ image: image.getAttribute('src') || '' }, noteImageFormats(image)));
}
