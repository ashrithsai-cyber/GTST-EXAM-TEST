// Copies the MediaPipe Tasks Vision WASM runtime out of the installed,
// version-pinned npm package into public/mediapipe/wasm, so face detection
// is served from our own origin instead of a third-party CDN during the
// exam. Runs automatically before `npm run dev` / `npm run build`.
// public/mediapipe/wasm is generated (gitignored); the model file
// public/mediapipe/blaze_face_short_range.tflite is committed.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const target = resolve(root, 'public/mediapipe/wasm');

if (!existsSync(source)) {
  console.error(`MediaPipe WASM not found at ${source} — run npm ci first.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
