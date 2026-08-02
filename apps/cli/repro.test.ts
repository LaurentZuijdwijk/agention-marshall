import { test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import React, { useState } from 'react';
import { render } from 'ink';
import { TextInput } from './src/view/TextInput.js';

const CTRL_V = '\u0016';

test('what does TextInput do with ctrl-V', async () => {
  const stdout = new Writable({ write(_c, _e, cb) { cb(); } }) as any;
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const stdin = new Readable({ read() {} }) as any;
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};

  let latest = '';
  const changes: string[] = [];
  function H() {
    const [v, s] = useState('');
    latest = v;
    return React.createElement(TextInput, {
      value: v,
      onChange: (next: string) => { changes.push(next); s(next); },
    });
  }
  const app = render(React.createElement(H), { stdout, stdin, patchConsole: false });
  await new Promise(r => setTimeout(r, 60));

  stdin.push('hi');
  await new Promise(r => setTimeout(r, 60));
  stdin.push(CTRL_V);
  await new Promise(r => setTimeout(r, 60));

  console.log('onChange calls:', JSON.stringify(changes));
  console.log('value after ctrl-V:', JSON.stringify(latest));
  app.unmount();
});
