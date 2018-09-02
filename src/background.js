/* Copyright 2018 _y_s */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
 (function () {
	'use strict';
	Array.prototype.last = function (i) {
		return this[this.length - (i || 0) - 1];
	};
	
	let ports = [];
	let enabled;
	let blacklist = [];
	
	// load storage
	browser.storage.local.get(['gesture', 'blacklist']).then(v => {
		let basic = 2047, extra = 0;
		let gesture = v && v.gesture;
		if (gesture) {
			basic = gesture.basic;
			extra = gesture.extra;
		} else {
			// for first use
			browser.notifications.onClicked.addListener(() => {
				browser.runtime.openOptionsPage();
			});
			browser.notifications.create({
				type: 'basic',
				title: 'Opera Gestures',
				message: browser.i18n.getMessage('notice_oninstalled'),
				iconUrl: browser.runtime.getURL('icon.svg'),
			});
			browser.storage.local.set({
				version: browser.runtime.getManifest().version,
				gesture: { basic: 2047, extra: 0 },
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
			'^https?://addons\\\.mozilla\\\.org/',
			'^https?://testpilot\\\.firefox\\\.com/',
		]).map(s => new RegExp(s));
	});

	browser.runtime.onConnect.addListener(p => {
		let tab = p.sender.tab;
		if (!blacklist.some(re => re.test(p.sender.url))) {
			ports[tab.id] = p;
			p.onMessage.addListener(onmessage.bind(p));
		}
	});

	// main
	let gestures = [];
	let isUrl = url => typeof url === 'string' && url.startsWith('http');
	let func = new Map([
		['down', function (url) {
			let opt = isUrl(url) ? { url: url } : {};
			browser.tabs.create(opt);
		}],
		['down,up', function (url) {
			let opt = {
				active: false,
				url: isUrl(url) ? url : this.sender.url,
			};
			browser.tabs.create(opt);
		}],
		['down,right', function () {
			browser.tabs.remove(this.sender.tab.id);
		}],
		['down,left', async function () {
			let currentWindow = await browser.windows.getCurrent();
			if (currentWindow) {
				let opt = { state: 'minimized' };
				browser.windows.update(currentWindow.id, opt);
			}
		}],
		['up,right', async function () {
			let currentWindow = await browser.windows.getCurrent();
			if (currentWindow) {
				let opt = { state: currentWindow.state === 'normal' ? 'maximized' : 'normal' };
				browser.windows.update(currentWindow.id, opt);
			}
		}],
		['right,up', async function () {
			let sessions = await browser.sessions.getRecentlyClosed({ maxResults: 1 });
			if (sessions.length) {
				browser.sessions.restore((sessions[0].tab || sessions[0].window).sessionId);
			}
		}],
	]);

	async function onmessage(m) {
		let port = this;
		if (enabled.get('wheel') && 'direction' in m) {
			let tabs = await browser.tabs.query({ currentWindow: true });
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
				let state = m.states[(gestures.length && m.states[0] === gestures.last() && m.states[1] !== gestures.last())|0];
				if (state && state !== gestures.last() && state !== gestures.last(1)) {
					gestures.push(state);
				}
			}
			if (m.execute) {
				let gesture = gestures.join();
				if (enabled.get(gesture)) {
					if (func.has(gesture)) {
						func.get(gesture).bind(port)(m.url);
					} else {
						port.postMessage({ func: gesture });
					}
				}
				gestures = [];
			}
		}
	}
})();