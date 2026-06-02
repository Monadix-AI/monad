interface GlobalKeyboardInputCapture {
  id: number;
  options: GlobalKeyboardInputCaptureOptions;
  scope: HTMLElement;
}

export interface GlobalKeyboardInputCaptureOptions {
  onPaste?: (event: ClipboardEvent) => boolean | undefined;
}

let nextCaptureId = 1;
const captures: GlobalKeyboardInputCapture[] = [];
let documentListenersInstalled = false;

function activeCapture(): GlobalKeyboardInputCapture | undefined {
  return captures.at(-1);
}

function eventTargetInsideScope(event: Event, scope: HTMLElement): boolean {
  const target = event.target;
  return target instanceof Node && typeof scope.contains === 'function' ? scope.contains(target) : false;
}

function stopEventAtGlobalBoundary(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function handleGlobalPaste(event: ClipboardEvent): void {
  const capture = activeCapture();
  if (!capture) return;
  const handled = capture.options.onPaste?.(event) === true;
  if (handled || !eventTargetInsideScope(event, capture.scope)) stopEventAtGlobalBoundary(event);
}

function handleGlobalKeyboardEvent(event: Event): void {
  const capture = activeCapture();
  if (!capture || eventTargetInsideScope(event, capture.scope)) return;
  stopEventAtGlobalBoundary(event);
}

function installDocumentListeners(): void {
  if (documentListenersInstalled || typeof document === 'undefined') return;
  document.addEventListener('paste', handleGlobalPaste, true);
  document.addEventListener('beforeinput', handleGlobalKeyboardEvent, true);
  document.addEventListener('input', handleGlobalKeyboardEvent, true);
  document.addEventListener('keydown', handleGlobalKeyboardEvent, true);
  document.addEventListener('keypress', handleGlobalKeyboardEvent, true);
  document.addEventListener('keyup', handleGlobalKeyboardEvent, true);
  documentListenersInstalled = true;
}

function uninstallDocumentListeners(): void {
  if (!documentListenersInstalled || typeof document === 'undefined') return;
  document.removeEventListener('paste', handleGlobalPaste, true);
  document.removeEventListener('beforeinput', handleGlobalKeyboardEvent, true);
  document.removeEventListener('input', handleGlobalKeyboardEvent, true);
  document.removeEventListener('keydown', handleGlobalKeyboardEvent, true);
  document.removeEventListener('keypress', handleGlobalKeyboardEvent, true);
  document.removeEventListener('keyup', handleGlobalKeyboardEvent, true);
  documentListenersInstalled = false;
}

export function acquireGlobalKeyboardInput(
  scope: HTMLElement,
  options: GlobalKeyboardInputCaptureOptions = {}
): () => void {
  installDocumentListeners();
  const capture = { id: nextCaptureId++, options, scope };
  captures.push(capture);
  return () => {
    const index = captures.findIndex((candidate) => candidate.id === capture.id);
    if (index >= 0) captures.splice(index, 1);
    if (captures.length === 0) uninstallDocumentListeners();
  };
}

export function isGlobalKeyboardInputCaptured(): boolean {
  return captures.length > 0;
}

export function globalKeyboardInputCaptureScope(): HTMLElement | null {
  return captures.at(-1)?.scope ?? null;
}

export function resetGlobalKeyboardInputCapturesForTest(): void {
  captures.length = 0;
  nextCaptureId = 1;
  uninstallDocumentListeners();
}
