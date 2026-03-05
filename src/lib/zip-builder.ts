import { zipSync, strToU8 } from "fflate";

export function buildZip(files: Record<string, string>): Uint8Array {
  const zipData: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    zipData[path] = strToU8(content);
  }
  return zipSync(zipData);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
