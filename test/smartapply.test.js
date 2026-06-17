import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartapply } from '../src/index.js';

test('test_smartapply_file_deletion', async () => {
  const diffText = `diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1,3 +0,0 @@
-def deprecated():
-    print("Remove me")`;

  const originalFiles = {
    'old.py': "def deprecated():\n    print('Remove me')",
  };

  const updatedFiles = await smartapply(diffText, originalFiles);

  assert.ok(!('old.py' in updatedFiles));
  assert.equal(Object.keys(updatedFiles).length, 0);

  const result = await smartapply(diffText, {});
  assert.equal(Object.keys(result).length, 0);
});

test('test_smartapply_file_modification', async () => {
  const diffText = `diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,2 +1,5 @@
 def hello():
     print('Hello')
+
+def goodbye():
+    print('Goodbye')`;

  const originalHello = "def hello():\n    print('Hello')";
  const originalFiles = {
    'hello.py': originalHello,
  };

  const mock = async () => "\ndef goodbye():\n    print('Goodbye')";
  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mock });

  assert.ok('hello.py' in updatedFiles);
  assert.notEqual(originalHello, updatedFiles['hello.py']);
});

test('test_smartapply_think_then_modify', async () => {
  const diffText = `diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,2 +1,5 @@
 def hello():
     print('Hello')
+
+def goodbye():
+    print('Goodbye')`;

  const originalFiles = {
    'hello.py': "def hello():\n    print('Hello')",
  };

  // forceLlm: the patch applies cleanly, but this test exercises the LLM
  // think-stripping path specifically.
  const mock = async () => "<think>Hello from thoughts</think>\ndef goodbye():\n    print('Goodbye')";
  const updatedFiles = await smartapply(diffText, originalFiles, {
    callLlmForApply: mock,
    forceLlm: true,
  });

  assert.ok('hello.py' in updatedFiles);
  assert.equal(updatedFiles['hello.py'], "def goodbye():\n    print('Goodbye')");
});

test('test_smartapply_new_file_creation', async () => {
  const diffText = `diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+def new_func():
+    print('New function')`;

  const originalFiles = {};

  // Clean creation applies via the deterministic fast path (no LLM call),
  // which normalizes a trailing newline.
  const mock = async () => "def new_func():\n    print('New function')";
  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mock });

  assert.ok('new.py' in updatedFiles);
  assert.equal(updatedFiles['new.py'], "def new_func():\n    print('New function')\n");
});

test('test_smartapply_modify_nonexistent_file', async () => {
  const diffText = `diff --git a/newfile.py b/newfile.py
--- a/newfile.py
+++ b/newfile.py
@@ -0,0 +1,2 @@
++def new_func():
++    print('Created via diff')`;

  const originalFiles = {};

  // forceLlm: the diff uses malformed double-'+' lines which the deterministic
  // applier interprets literally; the LLM path is what repairs it.
  const mock = async () => "def new_func():\n    print('Created via diff')";
  const updatedFiles = await smartapply(diffText, originalFiles, {
    callLlmForApply: mock,
    forceLlm: true,
  });

  assert.ok('newfile.py' in updatedFiles);
  assert.equal(updatedFiles['newfile.py'], "def new_func():\n    print('Created via diff')");

  const result = await smartapply(diffText, originalFiles, { callLlmForApply: mock, forceLlm: true });
  assert.ok('newfile.py' in result);
});

test('test_smartapply_multi_file_modification', async () => {
  const diffText = `diff --git a/file1.py b/file1.py
--- a/file1.py
+++ b/file1.py
@@ -1,2 +1,2 @@
 def func1():
-    print("Old func1")
+    print("New func1")
diff --git a/file2.py b/file2.py
--- a/file2.py
+++ b/file2.py
@@ -1,2 +1,2 @@
 def func2():
-    print("Old func2")
+    print("New func2")`;

  const originalFiles = {
    'file1.py': "def func1():\n    print('Old func1')",
    'file2.py': "def func2():\n    print('Old func2')",
    'unrelated.py': 'def unrelated():\n    pass',
  };

  const mockCallLlm = async (filePath, originalContent) => {
    if (filePath === 'file1.py') {
      return "def func1():\n    print('New func1')";
    } else if (filePath === 'file2.py') {
      return "def func2():\n    print('New func2')";
    }
    return originalContent;
  };

  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mockCallLlm });

  assert.ok('file1.py' in updatedFiles);
  assert.ok('file2.py' in updatedFiles);
  assert.ok('unrelated.py' in updatedFiles);

  assert.ok(updatedFiles['file1.py'].includes("print('New func1')"));
  assert.ok(updatedFiles['file2.py'].includes("print('New func2')"));

  assert.equal(updatedFiles['unrelated.py'], 'def unrelated():\n    pass');
});

test('test_smartapply_complex_single_hunk', async () => {
  const diffText = `diff --git a/complex.py b/complex.py
--- a/complex.py
+++ b/complex.py
@@ -1,7 +1,8 @@
 def process(data):
-    # Old processing logic
-    temp = data * 2
+    # Optimized pipeline
+    if not data:
+        return []
     results = []
-    for x in temp:
+    for x in data:
         results.append(x ** 2)
     return results`;

  const originalFiles = {
    'complex.py':
      'def process(data):\n' +
      '    # Old processing logic\n' +
      '    temp = data * 2\n' +
      '    results = []\n' +
      '    for x in temp:\n' +
      '        results.append(x ** 2)\n' +
      '    return results',
  };

  const expectedContent =
    'def process(data):\n' +
    '    # Optimized pipeline\n' +
    '    if not data:\n' +
    '        return []\n' +
    '    results = []\n' +
    '    for x in data:\n' +
    '        results.append(x ** 2)\n' +
    '    return results';

  const mock = async () => expectedContent;
  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mock });

  assert.ok('complex.py' in updatedFiles);
  const updated = updatedFiles['complex.py'];
  assert.ok(updated.includes('Optimized pipeline'));
  assert.ok(updated.includes('if not data:'));
  assert.ok(!updated.includes('temp = data * 2'));
  assert.ok(updated.includes('for x in data:'));
});

test('test_smartapply_deterministic_fast_path_skips_llm', async () => {
  const diffText = `diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,2 +1,5 @@
 def hello():
     print('Hello')
+
+def goodbye():
+    print('Goodbye')`;

  const originalFiles = {
    'hello.py': "def hello():\n    print('Hello')\n",
  };

  // The patch applies cleanly, so the LLM must never be called.
  const mock = async () => {
    throw new Error('LLM should not be called on a clean patch');
  };
  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mock });

  assert.equal(
    updatedFiles['hello.py'],
    "def hello():\n    print('Hello')\n\ndef goodbye():\n    print('Goodbye')\n",
  );
});

test('test_smartapply_falls_back_to_llm_on_unclean_patch', async () => {
  // Context lines do not match the original (single vs double quotes), so the
  // deterministic apply fails and the LLM fallback must run.
  const diffText = `diff --git a/file1.py b/file1.py
--- a/file1.py
+++ b/file1.py
@@ -1,2 +1,2 @@
 def func1():
-    print("Old func1")
+    print("New func1")`;

  const originalFiles = {
    'file1.py': "def func1():\n    print('Old func1')",
  };

  let called = false;
  const mock = async () => {
    called = true;
    return "def func1():\n    print('New func1')";
  };
  const updatedFiles = await smartapply(diffText, originalFiles, { callLlmForApply: mock });

  assert.ok(called, 'LLM fallback should be invoked for an unclean patch');
  assert.ok(updatedFiles['file1.py'].includes("print('New func1')"));
});

test('test_smartapply_forceLlm_bypasses_fast_path', async () => {
  const diffText = `diff --git a/hello.py b/hello.py
--- a/hello.py
+++ b/hello.py
@@ -1,2 +1,5 @@
 def hello():
     print('Hello')
+
+def goodbye():
+    print('Goodbye')`;

  const originalFiles = {
    'hello.py': "def hello():\n    print('Hello')",
  };

  let called = false;
  const mock = async () => {
    called = true;
    return "def hello():\n    print('Hello')\n\ndef goodbye():\n    print('Goodbye')";
  };
  await smartapply(diffText, originalFiles, { callLlmForApply: mock, forceLlm: true });

  assert.ok(called, 'forceLlm should send even clean patches to the LLM');
});

test('test_smartapply_new_file_with_incorrect_header', async () => {
  const diffText = `
diff --git a/game.js b/game.js
--- a/game.js
++++ b/game.js
@@ -0,0 +1,3 @@
+let player = {
+    class: "Warrior",
+};
`;

  const originalFiles = {};
  const expectedContent = 'let player = {\n    class: "Warrior",\n};';
  // forceLlm: this test exercises the malformed-header LLM creation path.
  const mockCallLlm = async () => expectedContent;
  const updatedFiles = await smartapply(diffText, originalFiles, {
    callLlmForApply: mockCallLlm,
    forceLlm: true,
  });

  assert.ok('game.js' in updatedFiles, "The new file 'game.js' should be created");
  assert.equal(updatedFiles['game.js'], expectedContent, 'The file content should match the diff');
});
