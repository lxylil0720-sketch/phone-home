// lib/custom-app-audio-host.ts
// 自定义 APP 音频全局托管：把 voice.play 的音频从 CustomAppRunner 组件内部
// 提升到模块级单例，使音频不随 APP 窗口关闭而销毁——对齐内置音乐软件
// （lib/music-context.tsx）的「全局 <audio>」架构，让本地音频在退出 APP 后继续播放。
"use client";

import { isMediaStoreRef, loadMediaBlob } from "@/lib/media-cache-storage";

export type CustomAppAudioMeta = {
  appId?: string;
  appName?: string;
  title?: string;
  /** 发起播放的 APP 是否已关闭（关闭后仍继续播，直到用户手动停止） */
  appClosed?: boolean;
};

type ChannelState = {
  el: HTMLAudioElement;
  settle: (() => void) | null;
  objectUrl: string | null;
  loop: boolean;
  playing: boolean;
  meta: CustomAppAudioMeta;
};

// iOS 的播放解锁按元素记账：在用户手势窗口里让元素静音播一次，之后
// 程序化 play() 才不会被自动播放策略拦截。
const FRAME_AUDIO_UNLOCK_WAV =
  "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA";

const channels = new Map<string, ChannelState>();
const listeners = new Set<() => void>();

let floatRoot: HTMLDivElement | null = null;
let floatCard: HTMLDivElement | null = null;
let floatStyle: HTMLStyleElement | null = null;

function normalizeChannelName(value: unknown): string {
  return String(value ?? "voice") === "ambience" ? "ambience" : "voice";
}

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* ignore */ }
  }
  syncFloat();
}

export function subscribeCustomAppAudio(fn: () => void): () => void {
  listeners.add(fn);
  syncFloat();
  return () => { listeners.delete(fn); };
}

export type CustomAppAudioSnapshot = {
  active: boolean;
  appId: string;
  appName: string;
  title: string;
  isPlaying: boolean;
  appClosed: boolean;
};

export function getCustomAppAudioSnapshot(): CustomAppAudioSnapshot {
  const entry = channels.get("voice");
  return {
    active: Boolean(entry && (entry.playing || (entry.el.src && !entry.el.paused))),
    appId: entry?.meta.appId ?? "",
    appName: entry?.meta.appName ?? "",
    title: entry?.meta.title ?? "",
    isPlaying: entry?.playing ?? false,
    appClosed: entry?.meta.appClosed ?? false,
  };
}

function getChannel(name: string): ChannelState {
  let entry = channels.get(name);
  if (!entry) {
    const el = new Audio();
    el.setAttribute("playsinline", "");
    entry = { el, settle: null, objectUrl: null, loop: false, playing: false, meta: {} };
    channels.set(name, entry);
    el.addEventListener("play", () => { entry!.playing = true; notify(); });
    el.addEventListener("pause", () => { entry!.playing = false; notify(); });
    el.addEventListener("ended", () => { entry!.playing = false; notify(); });
  }
  return entry;
}

function unlockAudioEl(el: HTMLAudioElement): void {
  if (el.dataset.unlocked === "1") return;
  try {
    el.muted = true;
    el.src = FRAME_AUDIO_UNLOCK_WAV;
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
        el.muted = false;
        el.dataset.unlocked = "1";
      }).catch(() => { el.muted = false; });
    } else {
      el.muted = false;
      el.dataset.unlocked = "1";
    }
  } catch { /* 解锁失败不阻断，播放时宿主侧还有回落 */ }
}

function cleanupChannel(entry: ChannelState): void {
  const el = entry.el;
  el.onended = null;
  el.onerror = null;
  el.loop = false;
  try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
  if (entry.objectUrl) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* ignore */ }
    entry.objectUrl = null;
  }
  const settle = entry.settle;
  entry.settle = null;
  entry.playing = false;
  settle?.();
  notify();
}

export async function customAppAudioPlay(payload: {
  channel?: unknown;
  dataUrl?: unknown;
  src?: unknown;
  ref?: unknown;
  loop?: unknown;
  volume?: unknown;
  title?: unknown;
  appId?: string;
  appName?: string;
}): Promise<{ ok: boolean; loop?: boolean }> {
  const name = normalizeChannelName(payload.channel);
  const rawSrc = String(payload.dataUrl ?? payload.src ?? payload.ref ?? "");
  let src = rawSrc;
  let mediaObjectUrl: string | null = null;

  if (isMediaStoreRef(rawSrc)) {
    const media = await loadMediaBlob(rawSrc);
    if (!media) throw new Error("voice.play 找不到对应媒体，可能已被删除。");
    mediaObjectUrl = URL.createObjectURL(media.blob);
    src = mediaObjectUrl;
  } else if (!src.startsWith("data:audio/") && !src.startsWith("blob:")) {
    throw new Error("voice.play 需要音频 dataUrl 或 media-store:// 引用。");
  }

  const entry = getChannel(name);
  const prevSettle = entry.settle;
  entry.settle = null;
  cleanupChannel(entry);
  prevSettle?.();

  entry.objectUrl = mediaObjectUrl;
  entry.meta = {
    appId: payload.appId ?? entry.meta.appId,
    appName: payload.appName ?? entry.meta.appName,
    title: typeof payload.title === "string" ? payload.title : entry.meta.title,
    appClosed: false,
  };

  const el = entry.el;
  unlockAudioEl(el);
  el.loop = payload.loop === true;
  const volume = Number(payload.volume);
  el.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
  el.src = src;

  if (el.loop) {
    try {
      await el.play();
    } catch (err) {
      cleanupChannel(entry);
      throw new Error(`宿主音频播放被拦截:${err instanceof Error ? err.message : String(err)}`);
    }
    notify();
    return { ok: true, loop: true };
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (entry.settle === settle) entry.settle = null;
      cleanupChannel(entry);
      resolve({ ok: true });
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      if (entry.settle === settle) entry.settle = null;
      cleanupChannel(entry);
      reject(new Error(message));
    };
    entry.settle = settle;
    el.onended = settle;
    el.onerror = () => fail("宿主音频解码或播放失败");
    const p = el.play();
    notify();
    if (p && typeof p.catch === "function") {
      p.catch(err => fail(`宿主音频播放被拦截:${err instanceof Error ? err.message : String(err)}`));
    }
  });
}

export function customAppAudioStop(channel?: unknown): void {
  const entry = channels.get(normalizeChannelName(channel));
  if (entry) cleanupChannel(entry);
}

export function customAppAudioPause(channel?: unknown): void {
  const entry = channels.get(normalizeChannelName(channel));
  if (entry) {
    try { entry.el.pause(); } catch { /* ignore */ }
    notify();
  }
}

export function customAppAudioResume(channel?: unknown): void {
  const entry = channels.get(normalizeChannelName(channel));
  if (entry && entry.el.src) {
    void entry.el.play().catch(() => { /* ignore */ });
  }
}

/**
 * APP 卸载时调用：环境音（ambience）随 APP 一起停；voice 频道若归属本 APP，
 * 标记 appClosed 后继续播放，由全局悬浮球接管控制。
 */
export function customAppAudioMarkAppClosed(appId?: string): void {
  const ambience = channels.get("ambience");
  if (ambience && ambience.meta.appId === appId) cleanupChannel(ambience);

  const voice = channels.get("voice");
  if (voice && voice.meta.appId === appId && voice.meta.appClosed === false) {
    voice.meta.appClosed = true;
    notify();
  }
}

/** APP 重新打开时清除 appClosed 标记，悬浮球随之隐藏。 */
export function customAppAudioMarkAppOpen(appId?: string): void {
  const voice = channels.get("voice");
  if (voice && voice.meta.appId === appId) {
    voice.meta.appClosed = false;
    notify();
  }
}

// ── 全局悬浮球（原生 DOM，避免动 React 挂载链） ──

function ensureFloatStyle(): void {
  if (floatStyle) return;
  const style = document.createElement("style");
  style.textContent = `
  .caa-float{position:fixed;left:14px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;align-items:center;gap:8px;}
  .caa-float-dot{width:48px;height:48px;border-radius:50%;border:none;background:rgba(22,22,28,.92);color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}
  .caa-float-dot:active{transform:scale(.95);}
  .caa-float-card{display:none;max-width:210px;background:rgba(22,22,28,.94);color:#eee;border-radius:14px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}
  .caa-float-card[data-open]{display:block;}
  .caa-float-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .caa-float-sub{font-size:11px;color:#9a9aa3;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .caa-float-btns{display:flex;gap:8px;margin-top:8px;}
  .caa-float-btn{flex:1;border:none;border-radius:10px;padding:7px 0;font-size:12px;font-weight:600;cursor:pointer;background:rgba(255,255,255,.12);color:#eee;}
  .caa-float-btn-stop{background:rgba(236,65,65,.85);color:#fff;}
  `;
  document.head.appendChild(style);
  floatStyle = style;
}

function stopVoice(): void {
  customAppAudioStop("voice");
}

function syncFloat(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const snap = getCustomAppAudioSnapshot();
  if (!snap.active || !snap.appClosed) {
    if (floatRoot) {
      floatRoot.remove();
      floatRoot = null;
      floatCard = null;
    }
    return;
  }
  ensureFloatStyle();
  if (!floatRoot) {
    const root = document.createElement("div");
    root.className = "caa-float";
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "caa-float-dot";
    dot.setAttribute("aria-label", "自定义应用音频");
    dot.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    dot.addEventListener("click", () => {
      if (floatCard) floatCard.toggleAttribute("data-open");
    });
    const card = document.createElement("div");
    card.className = "caa-float-card";
    card.innerHTML =
      '<div class="caa-float-title">—</div>' +
      '<div class="caa-float-sub">—</div>' +
      '<div class="caa-float-btns">' +
      '<button type="button" class="caa-float-btn" data-act="toggle">暂停</button>' +
      '<button type="button" class="caa-float-btn caa-float-btn-stop" data-act="stop">停止</button>' +
      '</div>';
    card.querySelector<HTMLButtonElement>('[data-act="toggle"]')?.addEventListener("click", () => {
      if (getCustomAppAudioSnapshot().isPlaying) customAppAudioPause("voice");
      else customAppAudioResume("voice");
    });
    card.querySelector<HTMLButtonElement>('[data-act="stop"]')?.addEventListener("click", stopVoice);
    root.appendChild(dot);
    root.appendChild(card);
    document.body.appendChild(root);
    floatRoot = root;
    floatCard = card;
  }
  if (floatCard) {
    const titleEl = floatCard.querySelector<HTMLDivElement>(".caa-float-title");
    const subEl = floatCard.querySelector<HTMLDivElement>(".caa-float-sub");
    const toggleEl = floatCard.querySelector<HTMLButtonElement>('[data-act="toggle"]');
    if (titleEl) titleEl.textContent = snap.title || snap.appName || "正在播放";
    if (subEl) subEl.textContent = snap.appName || "自定义应用音频";
    if (toggleEl) toggleEl.textContent = snap.isPlaying ? "暂停" : "继续";
  }
}
