'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:info',
  'settings:get',
  'settings:set',
  'proxy:test',
  'whatsnew:open',
  'downloads:list',
  'downloads:detail',
  'downloads:probe',
  'downloads:add',
  'downloads:action',
  'downloads:contextMenu',
  'downloads:deleteMany',
  'downloads:pauseAll',
  'downloads:resumeAll',
  'queue:start',
  'queue:stop',
  'queue:state',
  'queue:delete',
  'queue:move',
  'queue:pick',
  'dialog:open',
  'dialog:payload',
  'dialog:pickFolder',
  'disk:free',
  'player:open',
  'player:external',
  'window:close',
  'window:minimize',
  'window:resize',
  'extension:openFolder',
  'power:cancel',
  'power:state',
  'shell:openPath',
  'shell:openProject',
  'shell:openSocial',
  'media:status',
  'media:install',
  'media:update',
  'media:isVideoPage',
  'media:probe',
  'update:state',
  'update:check',
  'update:action',
]);

const EVENTS = new Set([
  'downloads:added',
  'downloads:changed',
  'downloads:removed',
  'downloads:progress',
  'queue:state',
  'settings:changed',
  'theme:changed',
  'power:pending',
  'toast',
  'update:state',
  'ui:command',
  'media:install-progress',
]);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, fn) {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
