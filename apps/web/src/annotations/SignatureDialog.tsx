/**
 * Signature (spec §3): draw on a pad, type a name (set in the UI font; no script font is
 * bundled), or pick an image. The result is placed as a stamp annotation: an image
 * signature, not a digital signature, which the dialog says plainly.
 */
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type PointerEvent, useEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import overlay from '../shell/ShortcutOverlay.module.css';
import { announce } from '../shell/announcer';
import { useToolStore } from '../viewer/tool-store';
import { type PendingStamp, useAnnotationStore } from './annotation-store';
import { pickImageStamp } from './commands';
import styles from './SignatureDialog.module.css';
import { drawnSignature, typedSignature } from './stamps';

type Tab = 'draw' | 'type' | 'image';
type Stroke = { x: number; y: number }[];

const PAD_WIDTH = 440;
const PAD_HEIGHT = 160;

export function SignatureDialog() {
  const open = useAnnotationStore((s) => s.signatureDialogOpen);
  const setOpen = useAnnotationStore((s) => s.setSignatureDialogOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {open ? <SignatureForm onDone={() => setOpen(false)} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function arm(stamp: PendingStamp): void {
  useAnnotationStore.getState().setPendingStamp(stamp);
  useAnnotationStore.getState().select(null);
  useToolStore.getState().setMode('signature');
  announce(m.annot_place_signature());
}

function SignatureForm({ onDone }: { readonly onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('draw');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [typed, setTyped] = useState(() => useAnnotationStore.getState().author);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#1A237E';
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const stroke of strokes) {
      const [first, ...rest] = stroke;
      if (!first) continue;
      g.beginPath();
      g.moveTo(first.x, first.y);
      for (const p of rest) g.lineTo(p.x, p.y);
      g.stroke();
    }
  }, [strokes, tab]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - r.left) / r.width) * PAD_WIDTH,
      y: ((event.clientY - r.top) / r.height) * PAD_HEIGHT,
    };
  };

  const use = async () => {
    let stamp: PendingStamp | undefined;
    if (tab === 'draw') stamp = await drawnSignature(strokes);
    else if (tab === 'type' && typed.trim() !== '') stamp = await typedSignature(typed.trim());
    if (!stamp) return;
    onDone();
    arm(stamp);
  };

  const ready = tab === 'draw' ? strokes.length > 0 : tab === 'type' ? typed.trim() !== '' : true;

  return (
    <Dialog.Popup className={`${overlay.popup} ${styles.popup}`}>
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.signature_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.annot_cancel()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <div className={styles.body}>
        <Dialog.Description className={styles.notice}>{m.signature_notice()}</Dialog.Description>
        <div role="tablist" aria-label={m.signature_modes()} className={styles.tabs}>
          {(['draw', 'type', 'image'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={styles.tab}
              onClick={() => setTab(id)}
            >
              {{ draw: m.signature_draw, type: m.signature_type, image: m.signature_image }[id]()}
            </button>
          ))}
        </div>
        {tab === 'draw' ? (
          <div className={styles.padWrap}>
            <canvas
              ref={canvasRef}
              className={styles.pad}
              width={PAD_WIDTH}
              height={PAD_HEIGHT}
              role="img"
              aria-label={m.signature_pad()}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drawing.current = [point(e)];
                setStrokes((s) => [...s, drawing.current ?? []]);
              }}
              onPointerMove={(e) => {
                const stroke = drawing.current;
                if (!stroke) return;
                stroke.push(point(e));
                setStrokes((s) => [...s.slice(0, -1), [...stroke]]);
              }}
              onPointerUp={() => {
                drawing.current = null;
              }}
            />
            <button
              type="button"
              className={styles.secondary}
              disabled={strokes.length === 0}
              onClick={() => setStrokes([])}
            >
              {m.signature_clear()}
            </button>
          </div>
        ) : null}
        {tab === 'type' ? (
          <input
            className={styles.typed}
            aria-label={m.signature_type_label()}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        ) : null}
        {tab === 'image' ? <p className={styles.hint}>{m.signature_image_hint()}</p> : null}
        <div className={styles.actions}>
          <Dialog.Close className={styles.secondary}>{m.annot_cancel()}</Dialog.Close>
          <button
            type="button"
            className={styles.primary}
            disabled={!ready}
            onClick={() => {
              if (tab === 'image') {
                onDone();
                void pickImageStamp('signature');
              } else {
                void use();
              }
            }}
          >
            {tab === 'image' ? m.signature_choose_image() : m.signature_use()}
          </button>
        </div>
      </div>
    </Dialog.Popup>
  );
}
