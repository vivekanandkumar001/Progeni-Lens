import * as ort from './vendor/ort.min.mjs';

const IMG_SIZE = 640;
const IOU_THRESHOLD = 0.45;

const CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
  'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
  'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush'
];

const MODES = {
  traffic: {
    label: 'Traffic',
    targets: ['car', 'motorcycle', 'bus', 'truck'],
    alert: 'VEHICLE DETECTED',
    color: '#7cc4ff'
  },
  proctoring: {
    label: 'Proctoring',
    targets: ['cell phone', 'laptop', 'book'],
    alert: 'CHEATING ALERT',
    color: '#ff5c7a'
  },
  security: {
    label: 'Security',
    targets: ['person', 'knife', 'backpack'],
    alert: 'SECURITY BREACH',
    color: '#ffb24d'
  },
  workplace: {
    label: 'Workplace',
    targets: ['person', 'laptop', 'chair', 'bottle'],
    alert: 'WORKPLACE ACTIVITY',
    color: '#b8ff5c'
  }
};

const $ = (id) => document.getElementById(id);
const els = {
  modelStatus: $('modelStatus'),
  demoBtn: $('demoBtn'),
  heroDemoBtn: $('heroDemoBtn'),
  webcamBtn: $('webcamBtn'),
  clearBtn: $('clearBtn'),
  fileInput: $('fileInput'),
  confidence: $('confidence'),
  confValue: $('confValue'),
  webcam: $('webcam'),
  overlay: $('overlay'),
  emptyState: $('emptyState'),
  sourceLabel: $('sourceLabel'),
  detections: $('detections'),
  latency: $('latency'),
  fps: $('fps'),
  count: $('count'),
  alertBox: $('alertBox'),
  modes: $('modes')
};

ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

let session = null;
let currentMode = 'traffic';
let lastSource = null;
let lastDetections = [];
let currentObjectUrl = null;
let webcamStream = null;
let webcamActive = false;
let rafId = null;
let busy = false;
let lastInferAt = 0;

function setStatus(message, state = 'loading') {
  els.modelStatus.textContent = message;
  els.modelStatus.className = `status ${state}`;
}

function setButtons(enabled) {
  els.demoBtn.disabled = !enabled;
  els.heroDemoBtn.disabled = !enabled;
  els.webcamBtn.disabled = !enabled;
}

function setAlert(detections = []) {
  const mode = MODES[currentMode];
  const targetSet = new Set(mode.targets);
  const hits = detections.filter((d) => targetSet.has(d.name));
  const small = els.alertBox.querySelector('small');
  const bold = els.alertBox.querySelector('b');

  if (hits.length) {
    const names = [...new Set(hits.map((d) => d.name))].join(', ');
    els.alertBox.className = 'alert-box active';
    small.textContent = `${hits.length} target${hits.length > 1 ? 's' : ''} in frame`;
    bold.textContent = `${mode.alert} · ${names}`;
  } else {
    els.alertBox.className = 'alert-box idle';
    small.textContent = mode.label.toUpperCase() + ' MODE';
    bold.textContent = detections.length
      ? 'No target class in this frame'
      : 'Waiting for a frame';
  }
}

function renderDetections(detections) {
  els.detections.innerHTML = '';
  if (!detections.length) {
    const chip = document.createElement('span');
    chip.className = 'empty-chip';
    chip.textContent = 'No detections above threshold';
    els.detections.appendChild(chip);
    return;
  }

  const targetSet = new Set(MODES[currentMode].targets);
  detections.slice(0, 9).forEach((d) => {
    const chip = document.createElement('span');
    chip.className = `det-chip${targetSet.has(d.name) ? ' target' : ''}`;
    chip.textContent = `${d.name} ${Math.round(d.score * 100)}%`;
    els.detections.appendChild(chip);
  });

  if (detections.length > 9) {
    const more = document.createElement('span');
    more.className = 'empty-chip';
    more.textContent = `+${detections.length - 9} more`;
    els.detections.appendChild(more);
  }
}

function float32ToFloat16(value) {
  const buffer = new Float32Array(1);
  const ints = new Int32Array(buffer.buffer);
  buffer[0] = value;
  const x = ints[0];
  const sign = (x >> 16) & 0x8000;
  const exponent = (x >> 23) & 0xff;
  const fraction = x & 0x7fffff;

  if (exponent === 255) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  if (exponent >= 113) {
    let halfExponent = exponent - 112;
    let halfMantissa = fraction >> 13;
    const roundBit = (fraction >> 12) & 1;
    const sticky = (fraction & 0x0fff) !== 0;
    if (roundBit && (sticky || (halfMantissa & 1))) halfMantissa += 1;
    if (halfMantissa === 0x400) {
      halfMantissa = 0;
      halfExponent += 1;
    }
    if (halfExponent >= 31) return sign | 0x7c00;
    return sign | (halfExponent << 10) | halfMantissa;
  }
  if (exponent >= 103) {
    const extended = fraction | 0x800000;
    const shift = 126 - exponent;
    let halfMantissa = extended >> shift;
    const roundBit = (extended >> (shift - 1)) & 1;
    const sticky = (extended & ((1 << (shift - 1)) - 1)) !== 0;
    if (roundBit && (sticky || (halfMantissa & 1))) halfMantissa += 1;
    return sign | halfMantissa;
  }
  return sign;
}

function float16ToFloat32(value) {
  const sign = value & 0x8000 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const mantissa = value & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

function letterbox(source) {
  const width = source.naturalWidth || source.videoWidth;
  const height = source.naturalHeight || source.videoHeight;
  if (!width || !height) throw new Error('Source has no readable dimensions.');

  const scale = Math.min(IMG_SIZE / width, IMG_SIZE / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  const padX = Math.floor((IMG_SIZE - newW) / 2);
  const padY = Math.floor((IMG_SIZE - newH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = IMG_SIZE;
  canvas.height = IMG_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);
  ctx.drawImage(source, padX, padY, newW, newH);

  const pixels = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE).data;
  const plane = IMG_SIZE * IMG_SIZE;
  const input = new Uint16Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    input[i] = float32ToFloat16(pixels[p] / 255);
    input[plane + i] = float32ToFloat16(pixels[p + 1] / 255);
    input[2 * plane + i] = float32ToFloat16(pixels[p + 2] / 255);
  }

  return { input, meta: { width, height, scale, padX, padY } };
}

function decodeOutput(raw, dims, meta) {
  const threshold = parseFloat(els.confidence.value);
  let rows;
  let stride;
  let layout = 'row';

  if (dims && dims.length === 3) {
    const [, a, b] = dims;
    if (b === 85 || b === 6) {
      rows = a; stride = b; layout = 'row';
    } else if (a === 85 || a === 6) {
      rows = b; stride = a; layout = 'col';
    } else {
      rows = a; stride = b; layout = 'row';
    }
  } else if (dims && dims.length === 2) {
    rows = dims[0]; stride = dims[1];
  } else {
    rows = Math.floor(raw.length / 85); stride = 85;
  }

  if (!rows || !stride || stride < 6) return [];
  const value = (row, col) => (layout === 'row' ? raw[row * stride + col] : raw[col * rows + row]);
  const detections = [];

  for (let r = 0; r < rows; r++) {
    const objectness = value(r, 4);
    if (objectness < threshold * 0.4) continue;

    let bestScore = 0;
    let bestIndex = -1;
    for (let c = 5; c < stride; c++) {
      const score = value(r, c);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = c - 5;
      }
    }

    const confidence = objectness * bestScore;
    if (confidence < threshold || bestIndex < 0 || bestIndex >= CLASSES.length) continue;

    const cx = value(r, 0);
    const cy = value(r, 1);
    const bw = value(r, 2);
    const bh = value(r, 3);

    let x = (cx - bw / 2 - meta.padX) / meta.scale;
    let y = (cy - bh / 2 - meta.padY) / meta.scale;
    let w = bw / meta.scale;
    let h = bh / meta.scale;

    x = Math.max(0, Math.min(meta.width, x));
    y = Math.max(0, Math.min(meta.height, y));
    w = Math.max(0, Math.min(meta.width - x, w));
    h = Math.max(0, Math.min(meta.height - y, h));
    if (w < 1 || h < 1) continue;

    detections.push({
      x, y, w, h,
      cls: bestIndex,
      name: CLASSES[bestIndex],
      score: confidence
    });
  }

  return detections;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlapW = Math.max(0, x2 - x1);
  const overlapH = Math.max(0, y2 - y1);
  const intersection = overlapW * overlapH;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaxSuppression(detections) {
  const grouped = new Map();
  for (const detection of detections) {
    if (!grouped.has(detection.cls)) grouped.set(detection.cls, []);
    grouped.get(detection.cls).push(detection);
  }

  const kept = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => b.score - a.score);
    for (const candidate of group) {
      const suppressed = kept.some((other) => other.cls === candidate.cls && iou(other, candidate) > IOU_THRESHOLD);
      if (!suppressed) kept.push(candidate);
    }
  }
  return kept.sort((a, b) => b.score - a.score);
}

function drawDetections(source, detections) {
  const width = source.naturalWidth || source.videoWidth || els.overlay.width;
  const height = source.naturalHeight || source.videoHeight || els.overlay.height;
  const canvas = els.overlay;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  const targetSet = new Set(MODES[currentMode].targets);
  const fontSize = Math.max(11, Math.round(width / 62));
  ctx.font = `600 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(2, Math.round(width / 360));

  for (const d of detections) {
    const isTarget = targetSet.has(d.name);
    const color = isTarget ? MODES[currentMode].color : 'rgba(186, 201, 220, .64)';
    ctx.strokeStyle = color;
    ctx.strokeRect(d.x, d.y, d.w, d.h);

    const label = `${d.name} ${Math.round(d.score * 100)}%`;
    const labelWidth = ctx.measureText(label).width;
    const labelHeight = fontSize + 8;
    const labelX = Math.max(0, d.x);
    const labelY = Math.max(0, d.y - labelHeight);

    ctx.fillStyle = color;
    ctx.fillRect(labelX, labelY, labelWidth + 10, labelHeight);
    ctx.fillStyle = '#07100a';
    ctx.fillText(label, labelX + 5, labelY + 4);
  }
}

async function runInference(source, { isLive = false } = {}) {
  if (!session || busy) return;
  busy = true;
  const started = performance.now();

  try {
    const { input, meta } = letterbox(source);
    const tensor = new ort.Tensor('float16', input, [1, 3, IMG_SIZE, IMG_SIZE]);
    const outputName = session.outputNames[0];
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const output = results[outputName];

    let rawData = output.data;
    if (typeof Float16Array !== 'undefined' && rawData instanceof Float16Array) {
      rawData = Float32Array.from(rawData);
    } else if (output.type === 'float16' || rawData instanceof Uint16Array) {
      const decoded = new Float32Array(rawData.length);
      for (let i = 0; i < rawData.length; i++) decoded[i] = float16ToFloat32(rawData[i]);
      rawData = decoded;
    }

    const decoded = decodeOutput(rawData, output.dims, meta);
    const detections = nonMaxSuppression(decoded);
    const latency = performance.now() - started;

    lastSource = source;
    lastDetections = detections;
    els.emptyState.hidden = true;
    drawDetections(source, detections);
    renderDetections(detections);
    setAlert(detections);

    const targetCount = detections.filter((d) => MODES[currentMode].targets.includes(d.name)).length;
    els.count.textContent = String(targetCount);
    els.latency.textContent = `${Math.round(latency)} ms`;

    if (isLive) {
      const now = performance.now();
      els.fps.textContent = lastInferAt ? (1000 / Math.max(16, now - lastInferAt)).toFixed(1) : '—';
      lastInferAt = now;
    } else {
      els.fps.textContent = '—';
      lastInferAt = 0;
    }
  } catch (error) {
    console.error(error);
    setStatus(`Inference failed: ${error.message}`, 'error');
  } finally {
    busy = false;
  }
}

async function loadModel() {
  setStatus('Loading 14.7 MB model…', 'loading');
  try {
    session = await ort.InferenceSession.create(new URL('./models/yolov5s.onnx', import.meta.url).href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    setStatus(`Ready · ${session.inputNames[0]} → ${session.outputNames[0]}`, 'ready');
    setButtons(true);
    setAlert([]);
  } catch (error) {
    console.error(error);
    setStatus(`Model failed to load: ${error.message}`, 'error');
  }
}

async function runDemo() {
  stopWebcam();
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    els.sourceLabel.textContent = 'Demo image · bus.jpg';
    runInference(image);
  };
  image.onerror = () => setStatus('Demo image could not be loaded.', 'error');
  image.src = new URL('./assets/sample-bus.jpg', import.meta.url).href;
}

function stopWebcam() {
  webcamActive = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (webcamStream) {
    webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
  }
  els.webcam.srcObject = null;
  els.webcamBtn.textContent = 'Start webcam';
  els.fps.textContent = '—';
  lastInferAt = 0;
}

async function startWebcam() {
  if (!session) return;
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (error) {
    setStatus(`Camera unavailable: ${error.message}`, 'error');
    return;
  }

  els.webcam.srcObject = webcamStream;
  await els.webcam.play();
  webcamActive = true;
  els.webcamBtn.textContent = 'Stop webcam';
  els.emptyState.hidden = true;
  els.sourceLabel.textContent = 'Webcam · live frames';

  let lastFrameAt = 0;
  const loop = async (now) => {
    if (!webcamActive) return;
    if (!busy && now - lastFrameAt > 420) {
      lastFrameAt = now;
      await runInference(els.webcam, { isLive: true });
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function setMode(mode) {
  if (!MODES[mode]) return;
  currentMode = mode;
  els.modes.querySelectorAll('.mode-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  if (lastSource && lastDetections.length !== undefined) {
    drawDetections(lastSource, lastDetections);
    renderDetections(lastDetections);
    setAlert(lastDetections);
    els.count.textContent = String(lastDetections.filter((d) => MODES[mode].targets.includes(d.name)).length);
  } else {
    setAlert([]);
  }
}

function clearCanvas() {
  stopWebcam();
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  lastSource = null;
  lastDetections = [];
  els.overlay.width = els.overlay.width;
  els.emptyState.hidden = false;
  els.sourceLabel.textContent = 'No source loaded';
  els.latency.textContent = '—';
  els.fps.textContent = '—';
  els.count.textContent = '0';
  setAlert([]);
  renderDetections([]);
}

els.demoBtn.addEventListener('click', runDemo);
els.heroDemoBtn.addEventListener('click', () => {
  runDemo();
  document.getElementById('console').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.webcamBtn.addEventListener('click', () => (webcamActive ? stopWebcam() : startWebcam()));
els.clearBtn.addEventListener('click', clearCanvas);

els.modes.addEventListener('click', (event) => {
  const button = event.target.closest('.mode-btn');
  if (button) setMode(button.dataset.mode);
});

els.confidence.addEventListener('input', () => {
  els.confValue.value = parseFloat(els.confidence.value).toFixed(2);
  if (lastSource) runInference(lastSource, { isLive: webcamActive });
});

els.fileInput.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  stopWebcam();
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);

  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    els.sourceLabel.textContent = `Upload · ${file.name}`;
    runInference(image);
  };
  image.onerror = () => setStatus('That file could not be read as an image.', 'error');
  image.src = currentObjectUrl;
});

loadModel();
