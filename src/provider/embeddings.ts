/**
 * Embedding provider: calls Ollama's /api/embeddings endpoint.
 * Returns a float32 array (we'll encode it as base64 for storage).
 */
import type { openDb } from '../db/client';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'nomic-embed-text';
// Default embedding dimension for nomic-embed-text is 768
const EMBEDDING_DIM = 768;

export async function embed(text: string): Promise<number[]> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
    });
    if (!resp.ok) {
      console.warn(`Ollama embedding failed: ${resp.status} ${resp.statusText}. Returning zero vector.`);
      return new Float32Array(EMBEDDING_DIM);
    }
    const data = await resp.json();
    if (!data.embedding) {
      console.warn('No embedding returned from Ollama. Returning zero vector.');
      return new Float32Array(EMBEDDING_DIM);
    }
    // Ollama returns float64 numbers; we'll convert to float32 for storage.
    return new Float32Array(data.embedding as number[]);
  } catch (err) {
    console.error('Error calling Ollama embedding endpoint:', err);
    console.warn('Returning zero vector due to error.');
    return new Float32Array(EMBEDDING_DIM);
  }
}

/**
 * Encode a float32/float64 array as base64 for storage in SQLite.
 * We'll store as a base64 string of raw little-endian float32 bytes.
 * For simplicity, we'll just JSON.stringify the array and base64 that.
 * But we want to store as a vector; we'll use base64 of the raw bytes.
 * However, SQLite doesn't have a native vector type; we'll store as text.
 * We'll store as base64 of the raw little-endian float32 array.
 */
export function encodeVector(vec: number[] | Float32Array): string {
  // Convert to Float32Array if it's a regular array
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  // Convert to base64
  return btoa(String.fromCharCode(...new Uint8Array(f32.buffer)));
}

/**
 * Decode a base64 string back to a number[].
 */
export function decodeVector(b64: string): number[] {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const f32 = new Float32Array(bytes.buffer);
  return Array.from(f32);
}