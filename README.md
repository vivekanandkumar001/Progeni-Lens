# Progeni Lens — Vercel build

A browser-only computer-vision demo: YOLOv5s (v7.0 ONNX) runs locally with ONNX Runtime Web. No Flask server, no image uploads to a backend, and no API keys.

## What is deployed

- `index.html` / `styles.css` — the live detection console UI
- `app.js` — letterbox preprocessing, ONNX inference, decode + per-class NMS, mode alerts
- `models/yolov5s.onnx` — official YOLOv5s v7.0 model (14.7 MB)
- `vendor/` — ONNX Runtime Web 1.22.0 WASM runtime (served locally, no CDN)
- `assets/sample-bus.jpg` — one-click demo frame from the Ultralytics YOLOv5 examples

## Run locally

```bash
python -m http.server 8010
# open http://localhost:8010
```

The first load downloads the 14.7 MB model. After that it is cached by the browser.

## Deploy

```bash
vercel --yes --prod
```

Static output, no build command required. GitHub pushes to the connected repository auto-deploy to production.

## Modes

Modes filter the model’s **COCO-80** classes. Only genuinely supported classes are listed:

| Mode | Target classes |
| --- | --- |
| Traffic | car, motorcycle, bus, truck |
| Proctoring | cell phone, laptop, book |
| Security | person, knife, backpack |
| Workplace | person, laptop, chair, bottle |

The demo uses the classic `bus.jpg` sample so traffic mode produces real vehicle/person detections on first click.

## Attribution

- YOLOv5s ONNX model: [Ultralytics YOLOv5](https://github.com/ultralytics/yolov5) — AGPL-3.0
- ONNX Runtime Web: [Microsoft](https://onnxruntime.ai/) — MIT
- Built by Vivekanand Kumar as part of the Progeni ecosystem.
