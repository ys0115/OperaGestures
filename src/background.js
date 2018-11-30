/* Copyright 2018 _y_s */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
 (function () {
	'use strict';
	let locus = false, touch = false;
	const ports = [];
	let enabled;
	let blacklist = [];
	
	// load storage
	browser.storage.local.get(['config', 'gesture', 'blacklist']).then(v => {
		locus = v && v.config.locus || false;
		touch = v && v.config.touch || false;

		let basic = 2047, extra = 0;
		const gesture = v && v.gesture;
		if (gesture) {
			basic = gesture.basic;
			extra = gesture.extra;
		} else {
			// for first use: open options page, discard other tabs 
			browser.runtime.openOptionsPage();
			if ('discard' in browser.tabs) {
				browser.tabs.query({ discarded: false }).then(tabs => {
					browser.tabs.discard(tabs.map(tab => tab.id));
				});
			}
			// for Android
			if (!('windows' in browser)) {
				basic = 511;
			}
			browser.storage.local.set({
				version: browser.runtime.getManifest().version,
				gesture: { basic: basic, extra: extra },
			});
		}
		enabled = new Map([
			['left', basic & 1],
			['right', basic & 2],
			['up,left', basic & 4],
			['up,down', basic & 8],
			['up', basic & 16],
			['down', basic & 32],
			['down,up', basic & 64],
			['wheel', basic & 128],
			['down,right', basic & 256],
			['down,left', basic & 512],
			['up,right', basic & 1024],
			['right,up', extra & 1],
			['wheel-skip', extra & 2],
		]);
		blacklist = (v && v.blacklist || [
			'^(?:about|chrome|file|jar|moz-extension|resource|view-source)',
			'\\\.(?:pdf|svg)$',
			'^https?://(?:accounts-static|addons|content)\\\.cdn\\\.mozilla\\\.net/',
			'^https?://(?:addons|discovery\\\.addons|input|install|support)\\\.mozilla\\\.org/',
			'^https?://(?:accounts|testpilot)\\\.firefox\\\.com/',
			'^https?://(?:api|oauth|profile)\\\.accounts\\\.firefox\\\.com/',
			'^https?://sync\\\.services\\\.mozilla\\\.com/',
		]).map(s => new RegExp(s));
	});

	browser.runtime.onConnect.addListener(p => {
		if (!blacklist.some(re => re.test(p.sender.url))) {
			const id = p.sender.tab.id;
			ports[id] = p;
			p.onMessage.addListener(onmessage.bind(p));
			if (locus) {
				browser.tabs.executeScript(id, {
					file: 'locus.js',
					runAt: 'document_end',
				});
			}
			if (touch) {
				browser.tabs.executeScript(id, {
					allFrames: true,
					file: 'touch.js',
					runAt: 'document_end',
				});
			}
		}
	});

	// main
	let gestures = [];
	const isUrl = url => typeof url === 'string' && url.startsWith('http');
	const func = new Map([
		['down', async function (url) {
			const opt = isUrl(url) ? { url: url } : {};
			browser.tabs.create(opt);
		}],
		['down,up', async function (url) {
			const _ = isUrl(url);
			if (!_ && 'duplicate' in browser.tabs) {
				browser.tabs.duplicate(this.sender.tab.id);
			} else {
				const opt = { active: false, url: _ ? url : this.sender.url };
				browser.tabs.create(opt);
			}
		}],
		['down,right', async function () {
			browser.tabs.remove(this.sender.tab.id);
		}],
		['down,left', async function () {
			const currentWindow = await browser.windows.getCurrent();
			const opt = { state: 'minimized' };
			browser.windows.update(currentWindow.id, opt);
		}],
		['up,right', async function () {
			const currentWindow = await browser.windows.getCurrent();
			const opt = { state: currentWindow.state === 'normal' ? 'maximized' : 'normal' };
			browser.windows.update(currentWindow.id, opt);
		}],
		['right,up', async function () {
			const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 1 });
			if (sessions.length) {
				browser.sessions.restore((sessions[0].tab || sessions[0].window).sessionId);
			}
		}],
	]);

	async function onmessage(m) {
		const port = this;
		if (enabled.get('wheel') && 'direction' in m) {
			const tabs = await browser.tabs.query({ currentWindow: true });
			let idx = port.sender.tab.index + m.direction;
			let target = tabs[idx];
			function judgeSkip(isPort) {
				if (enabled.get('wheel-skip') && !isPort) {
					idx += m.direction;
					selectTab();
				} else {
					port.postMessage({ func: 'leave' });
					ports[target.id].postMessage({ func: 'enter' });
				}
			}
			function observeConnection(port) {
				browser.runtime.onConnect.removeListener(observeConnection);
				judgeSkip(port);
			}
			function selectTab() {
				if (idx < 0) {
					idx = tabs.length - 1;
				} else if (idx >= tabs.length) {
					idx = 0;
				}
				target = tabs[idx];
				if (target.discarded) {
					browser.runtime.onConnect.addListener(observeConnection);
					browser.tabs.update(target.id, { active: true });
				} else {
					browser.tabs.update(target.id, { active: true }).then(() => {
						judgeSkip(ports[target.id]);
					});
				}
			}
			selectTab();
		} else {
			if (m.states) {
				const l = gestures.length;
				const state = m.states[(l && m.states[0] === gestures[l-1] && m.states[1] !== gestures[l-1])|0];
				if (state && state !== gestures[l-1] && state !== gestures[l-2]) {
					gestures.push(state);
				}
			}
			if (m.execute) {
				const gesture = gestures.join();
				if (enabled.get(gesture)) {
					if (func.has(gesture)) {
						func.get(gesture).bind(port)(m.url).catch(e => {
							port.postMessage({ error: e });
						});
					} else {
						port.postMessage({ func: gesture });
					}
				}
				gestures = [];
			}
		}
	}
})();