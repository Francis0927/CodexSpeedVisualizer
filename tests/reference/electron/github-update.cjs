const https = require("node:https");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY = "Francis0927/CodexSpeedVisualizer";
const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_HOSTS = new Set(["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error("更新下载地址不受支持");
  return url;
}

function response(url, redirects = 0) {
  const target = safeUrl(url);
  return new Promise((resolve, reject) => {
    const request = https.get(target, { headers: { "User-Agent": "Codex-Speed-Pet-updater", Accept: "application/vnd.github+json" } }, result => {
      if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
        result.resume();
        if (redirects >= 5 || !result.headers.location) { reject(new Error("更新下载重定向异常")); return; }
        try { resolve(response(new URL(result.headers.location, target).href, redirects + 1)); } catch (error) { reject(error); }
        return;
      }
      if (result.statusCode !== 200) {
        result.resume();
        reject(new Error(result.statusCode === 403 || result.statusCode === 429 ? "GitHub 请求受限，请稍后重试" : `GitHub 请求失败（HTTP ${result.statusCode}）`));
        return;
      }
      resolve(result);
    });
    request.setTimeout(30000, () => request.destroy(new Error("GitHub 连接超时")));
    const deadline = setTimeout(() => request.destroy(new Error("GitHub 请求超时")), 10 * 60 * 1000);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
  });
}

async function readText(url, limit = 2 * 1024 * 1024) {
  const stream = await response(url);
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) { stream.destroy(); throw new Error("GitHub 更新信息过大"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function compareVersions(a, b) {
  if (![a, b].every(value => /^\d+\.\d+\.\d+$/.test(value))) throw new Error("更新版本号无效");
  const left = a.split(".").map(BigInt), right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function releaseVersion(release) {
  if (!release || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error("GitHub 未提供有效的正式版本");
  return release.tag_name.slice(1);
}

function releaseAssets(release) {
  const version = releaseVersion(release);
  const select = name => {
    const matches = (release.assets || []).filter(asset => asset.name === name);
    const asset = matches[0];
    if (matches.length !== 1 || asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 * 1024 * 1024) throw new Error(`GitHub 缺少有效更新附件：${name}`);
    const url = safeUrl(asset.browser_download_url);
    if (url.hostname !== "github.com" || decodeURIComponent(url.pathname) !== `/${REPOSITORY}/releases/download/v${version}/${name}` || url.search || url.hash) throw new Error("更新附件不属于当前仓库和版本");
    if (asset.digest && !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error("更新附件 SHA-256 无效");
    return { name, url: url.href, size: asset.size, digest: asset.digest?.slice(7).toLowerCase() || null };
  };
  return { version, installer: select(`Codex-Speed-Pet-Setup-${version}.exe`), portable: select(`Codex-Speed-Pet-portable-${version}.zip`), checksums: select("SHA256SUMS.txt") };
}

function checksumFor(text, asset) {
  const entries = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map(line => /^([a-f0-9]{64})  (.+)$/i.exec(line));
  if (entries.some(entry => !entry)) throw new Error("SHA256SUMS.txt 格式无效");
  const matches = entries.filter(entry => entry[2] === asset.name);
  if (matches.length !== 1) throw new Error("更新附件缺少唯一 SHA-256 校验值");
  const digest = matches[0][1].toLowerCase();
  if (asset.digest && asset.digest !== digest) throw new Error("GitHub 附件与校验文件不一致");
  return digest;
}

async function download(asset, target, digest, open = response) {
  // Open exclusively before starting the request, so cleanup only owns this file.
  const file = await fsp.open(target, "wx");
  const hash = createHash("sha256"); let size = 0;
  const verifier = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > asset.size) { callback(new Error("更新文件大小异常")); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  try {
    const stream = await open(asset.url);
    await pipeline(stream, verifier, file.createWriteStream());
    if (size !== asset.size || hash.digest("hex") !== digest) throw new Error("更新文件 SHA-256 或大小校验失败");
  } catch (error) { await file.close(); await fsp.rm(target, { force: true }); throw error; }
  finally { await file.close(); }
}

module.exports = { REPOSITORY, LATEST_URL, safeUrl, readText, compareVersions, releaseVersion, releaseAssets, checksumFor, download };
