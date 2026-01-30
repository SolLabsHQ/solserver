export const LATTICE_EMBED_DIM = 64;

const hashToken = (token: string): number => {
  let hash = 5381;
  for (let i = 0; i < token.length; i += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
};

export const computeLatticeEmbedding = (text: string, dim = LATTICE_EMBED_DIM): number[] => {
  const vec = new Array(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

  for (const token of tokens) {
    const idx = hashToken(token) % dim;
    vec[idx] += 1;
  }

  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) {
      vec[i] = vec[i] / norm;
    }
  }

  return vec;
};

export const serializeEmbedding = (embedding: number[]): string => JSON.stringify(embedding);
