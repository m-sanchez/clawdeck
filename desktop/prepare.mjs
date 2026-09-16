import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { ocelotIcon } from "../ui/ocelin/ocelot-art.mjs";

const assets = fileURLToPath(new URL("./assets/", import.meta.url));
mkdirSync(assets, { recursive: true });
const svg = ocelotIcon(16);
const paths = [...svg.matchAll(/<path fill="(#[a-f0-9]+)" d="([^"]+)"/g)].map(
  ([, color, path]) => {
    const tokens = path.match(/[MmhHvVzZ]|-?\d+/g);
    const polygons = [];
    let x = 0,
      y = 0,
      polygon = [],
      i = 0;
    while (i < tokens.length) {
      const command = tokens[i++];
      if (command === "M") {
        x = Number(tokens[i++]);
        y = Number(tokens[i++]);
        polygon = [[x, y]];
      } else if (command === "h") {
        x += Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "H") {
        x = Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "v") {
        y += Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "V") {
        y = Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command.toLowerCase() === "z") polygons.push(polygon);
    }
    return {
      color: [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)),
      polygons,
    };
  },
);
function inside(x, y, polygon) {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = polygon[i],
      [c, d] = polygon[j];
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) yes = !yes;
  }
  return yes;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, value) {
  const data = Buffer.concat([Buffer.from(type), value]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(value.length);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = Math.floor((x * 16) / size) + 0.5,
        py = Math.floor((y * 16) / size) + 0.5;
      for (const p of paths)
        if (p.polygons.some((polygon) => inside(px, py, polygon))) {
          const offset = y * (size * 4 + 1) + 1 + x * 4;
          rows.set([...p.color, 255], offset);
        }
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(`${assets}/ocelin.png`, png(32));
const image = png(256),
  ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(image.length, 14);
ico.writeUInt32LE(22, 18);
writeFileSync(`${assets}/ocelin.ico`, Buffer.concat([ico, image]));
writeFileSync(
  fileURLToPath(new URL("../ui/ocelin/icon.svg", import.meta.url)),
  ocelotIcon(32),
);
