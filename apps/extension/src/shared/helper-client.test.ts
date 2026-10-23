import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHelperClient, HELPER_MISSING, HelperError, NATIVE_HOST } from './helper-client.ts';
import type { SendNative } from './helper-client.ts';
import type { HelperStatus, MyFile } from './helper-types.ts';

const FILE: MyFile = { name: 'resume.pdf', kind: 'pdf', words: 412, status: 'read', modified: '2026-10-23' };

const STATUS: HelperStatus = {
  version: '1.0.0',
  claude: { path: '/opt/homebrew/bin/claude', loggedIn: true, plan: 'max', problem: null },
  tectonic: { path: '/Users/alex/.theseer/bin/tectonic' },
  template: { path: '/Users/alex/.theseer/templates/default.tex' },
  profileDir: '/Users/alex/TheSeer/My files',
  outputDir: '/Users/alex/TheSeer/Resumes',
  files: [FILE],
  profileProblem: null,
};

interface Sent {
  host: string;
  message: object;
}

/** A `send` that records what it was given and answers with `reply`. */
function replying(reply: unknown): { send: SendNative; sent: Sent[] } {
  const sent: Sent[] = [];
  const send: SendNative = async (host, message) => {
    sent.push({ host, message });
    return reply;
  };
  return { send, sent };
}

/** A `send` that fails the way `chrome.runtime.sendNativeMessage` does. */
function rejecting(reason: string): SendNative {
  return async () => {
    throw new Error(reason);
  };
}

async function failureOf(call: Promise<unknown>): Promise<HelperError> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HelperError, `expected a HelperError, got ${String(err)}`);
    return err;
  }
  return assert.fail('expected the call to reject');
}

describe('NATIVE_HOST', () => {
  it('is the helper registered with Chrome', () => {
    assert.equal(NATIVE_HOST, 'com.theseer.resumegen');
  });
});

describe('createHelperClient commands', () => {
  it('status sends { command: "status" } and returns the status', async () => {
    const { send, sent } = replying({ success: true, status: STATUS });
    assert.deepEqual(await createHelperClient(send).status(), STATUS);
    assert.deepEqual(sent, [{ host: 'com.theseer.resumegen', message: { command: 'status' } }]);
  });

  it('addFile sends the name and the base64 data and returns the stored file', async () => {
    const { send, sent } = replying({ success: true, file: FILE });
    assert.deepEqual(await createHelperClient(send).addFile('resume.pdf', 'JVBERi0='), FILE);
    assert.deepEqual(sent, [
      { host: 'com.theseer.resumegen', message: { command: 'add-file', name: 'resume.pdf', dataBase64: 'JVBERi0=' } },
    ]);
  });

  it('addFile also sends the file\'s own date when given, so the helper keeps it', async () => {
    const lastModified = new Date(2026, 2, 14, 9, 30).getTime();
    const { send, sent } = replying({ success: true, file: FILE });
    assert.deepEqual(await createHelperClient(send).addFile('resume.pdf', 'JVBERi0=', lastModified), FILE);
    assert.deepEqual(sent, [
      {
        host: 'com.theseer.resumegen',
        message: { command: 'add-file', name: 'resume.pdf', dataBase64: 'JVBERi0=', lastModified },
      },
    ]);
  });

  it('removeFile sends the name and returns the files left', async () => {
    const { send, sent } = replying({ success: true, files: [FILE] });
    assert.deepEqual(await createHelperClient(send).removeFile('old.pdf'), [FILE]);
    assert.deepEqual(sent, [{ host: 'com.theseer.resumegen', message: { command: 'remove-file', name: 'old.pdf' } }]);
  });

  it('removeFile returns an empty list when no file is left', async () => {
    const { send } = replying({ success: true, files: [] });
    assert.deepEqual(await createHelperClient(send).removeFile('last.pdf'), []);
  });

  it('chooseFolder sends { command: "choose-folder" } and returns the chosen path', async () => {
    const { send, sent } = replying({ success: true, path: '/Users/alex/Documents/Resumes' });
    assert.equal(await createHelperClient(send).chooseFolder(), '/Users/alex/Documents/Resumes');
    assert.deepEqual(sent, [{ host: 'com.theseer.resumegen', message: { command: 'choose-folder' } }]);
  });

  it('chooseFolder returns null when the user cancels', async () => {
    const { send } = replying({ success: true, path: null });
    assert.equal(await createHelperClient(send).chooseFolder(), null);
  });

  it('setOutput sends the folder as outputDir and returns the folder the helper saved', async () => {
    const { send, sent } = replying({ success: true, outputDir: '/Users/alex/Resumes' });
    assert.equal(await createHelperClient(send).setOutput('/Users/alex/Resumes'), '/Users/alex/Resumes');
    assert.deepEqual(sent, [
      { host: 'com.theseer.resumegen', message: { command: 'set-output', outputDir: '/Users/alex/Resumes' } },
    ]);
  });

  it('openFolder sends which folder to open', async () => {
    for (const which of ['files', 'resumes'] as const) {
      const { send, sent } = replying({ success: true });
      await createHelperClient(send).openFolder(which);
      assert.deepEqual(sent, [{ host: 'com.theseer.resumegen', message: { command: 'open-folder', which } }]);
    }
  });
});

describe('createHelperClient when the helper is not installed', () => {
  const REASONS = [
    'Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden.',
  ];

  for (const reason of REASONS) {
    it(`turns "${reason}" into the install hint`, async () => {
      const err = await failureOf(createHelperClient(rejecting(reason)).status());
      assert.equal(err.message, HELPER_MISSING);
      assert.equal(err.notInstalled, true);
      assert.equal(err.needsSetup, true);
    });
  }

  it('says where to find the install command', () => {
    assert.equal(
      HELPER_MISSING,
      "The Seer's helper isn't installed — run the install command from the setup page",
    );
  });

  it('applies to every command', async () => {
    const client = createHelperClient(rejecting(REASONS[0]));
    const calls = [
      client.status(),
      client.addFile('a.pdf', ''),
      client.removeFile('a.pdf'),
      client.chooseFolder(),
      client.setOutput('/x'),
      client.openFolder('files'),
    ];
    for (const call of calls) {
      assert.equal((await failureOf(call)).notInstalled, true);
    }
  });
});

describe('createHelperClient when the call fails', () => {
  it('reports another transport failure with its reason, not as a missing helper', async () => {
    const err = await failureOf(createHelperClient(rejecting('Native host has exited.')).status());
    assert.match(err.message, /Native host has exited\./);
    assert.equal(err.notInstalled, false);
    assert.equal(err.needsSetup, false);
  });

  it('reports a thrown value that is not an Error', async () => {
    const send: SendNative = async () => {
      throw 'boom';
    };
    const err = await failureOf(createHelperClient(send).status());
    assert.match(err.message, /boom/);
  });

  it("turns a failure reply into a HelperError with the helper's message", async () => {
    const { send } = replying({ success: false, type: 'error', error: 'Disk is full' });
    const err = await failureOf(createHelperClient(send).addFile('a.pdf', ''));
    assert.equal(err.message, 'Disk is full');
    assert.equal(err.notInstalled, false);
    assert.equal(err.needsSetup, false);
    assert.equal(err.details, undefined);
  });

  it('keeps needsSetup and details from a failure reply', async () => {
    const { send } = replying({
      success: false,
      type: 'error',
      error: 'x',
      details: 'run claude /login',
      needsSetup: true,
    });
    const err = await failureOf(createHelperClient(send).status());
    assert.equal(err.message, 'x');
    assert.equal(err.needsSetup, true);
    assert.equal(err.notInstalled, false);
    assert.equal(err.details, 'run claude /login');
  });

  it('is an Error named HelperError', async () => {
    const { send } = replying({ success: false, error: 'x' });
    const err = await failureOf(createHelperClient(send).status());
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'HelperError');
  });
});

describe('createHelperClient with an unexpected reply', () => {
  it('rejects a malformed status', async () => {
    const { send } = replying({ success: true, status: { version: '1.0.0' } });
    const err = await failureOf(createHelperClient(send).status());
    assert.match(err.message, /Unexpected reply/);
    assert.equal(err.notInstalled, false);
  });

  it('rejects a reply that is not an object', async () => {
    for (const reply of [undefined, null, 'ok', 3]) {
      const { send } = replying(reply);
      const err = await failureOf(createHelperClient(send).status());
      assert.match(err.message, /Unexpected reply/, String(reply));
    }
  });

  it('rejects a reply with neither success true nor a failure message', async () => {
    for (const reply of [{}, { success: 'yes' }, { success: false }, { success: false, error: 5 }]) {
      const { send } = replying(reply);
      const err = await failureOf(createHelperClient(send).status());
      assert.match(err.message, /Unexpected reply/, JSON.stringify(reply));
    }
  });

  it('rejects a reply missing the field the command returns', async () => {
    const bare = { success: true };
    const calls = [
      createHelperClient(replying(bare).send).addFile('a', ''),
      createHelperClient(replying(bare).send).removeFile('a'),
      createHelperClient(replying(bare).send).chooseFolder(),
      createHelperClient(replying(bare).send).setOutput('/x'),
    ];
    for (const call of calls) {
      assert.match((await failureOf(call)).message, /Unexpected reply/);
    }
  });

  it('rejects files that are not all files', async () => {
    const { send } = replying({ success: true, files: [FILE, { name: 'x' }] });
    assert.match((await failureOf(createHelperClient(send).removeFile('a'))).message, /Unexpected reply/);
  });

  it('rejects a stored file that is malformed', async () => {
    const { send } = replying({ success: true, file: { name: 'x' } });
    assert.match((await failureOf(createHelperClient(send).addFile('x', ''))).message, /Unexpected reply/);
  });

  it('rejects a folder path that is neither a string nor null', async () => {
    const { send } = replying({ success: true, path: 5 });
    assert.match((await failureOf(createHelperClient(send).chooseFolder())).message, /Unexpected reply/);
  });

  it('names the command and tells the user to run the install command again', async () => {
    const { send } = replying({ success: true });
    const err = await failureOf(createHelperClient(send).status());
    assert.match(err.message, /status/);
    assert.match(err.message, /install command/);
  });
});
