import { invoke } from '@tauri-apps/api/core';

// The installed app runs as administrator (src-tauri/src/system.rs): links go through Explorer
// so the browser runs as the user, and autostart is a Task Scheduler entry.

/** Opens an http(s) link in the user's normal browser. */
export const openUrl = (url: string) => invoke<void>('open_url', { url });

export const isEnabled = () => invoke<boolean>('autostart_enabled');
export const enable = () => invoke<void>('set_autostart', { on: true });
export const disable = () => invoke<void>('set_autostart', { on: false });
