export async function audioBlobToBase64(audio: Blob): Promise<{ audioBase64: string; mediaType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio recording'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(audio);
  });
  const comma = dataUrl.indexOf(',');
  return {
    audioBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    mediaType: audio.type || dataUrl.slice(5, Math.max(5, comma)).split(';')[0] || 'audio/webm'
  };
}
