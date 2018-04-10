Do it live
----------

Because npm installing in production every 30 seconds is a great idea, right? ...right?

## Quick Start

```bash
npm install --save grabthar
```

## Examples

Hot deploy and serve up static files:

```javascript
import { poll } from 'grabthar';

let watcher = poll({
  name: 'my-live-updating-module'
});

app.get('/foo.js', async function handleRequest(req, res) {
  const { path } = await watcher.get();
  res.sendFile(`${ path }/dist/foo.js`);
});
```

Or if you're feeling *really* brave, hot deploy and require new code:

```javascript
import { poll } from 'grabthar';

let watcher = poll({
  name: 'my-live-updating-module'
});

app.get('/api/foo', async function handleRequest(req, res) {
  const { getFoo } = await watcher.import();
  res.json(getFoo());
});
```

## Deploying

By default `grabthar` will use the current `latest` tag of your chosen module, from npm.

So, to deploy and activate new code, just:

```bash
npm version patch;
npm publish;
```

This will automatically set the `latest` tag to the latest version.

## Deploying and activating in different steps

To separate out the deployment and activation of new code, you can make use of different npm dist-tags:

```javascript
import { poll } from 'grabthar';

let watcher = poll({
  name: 'my-live-updating-module',
  tags: [ 'latest', 'release' ]
});

app.get('/foo.js', async function handleRequest(req, res) {
  const { path } = await watcher.get('release');
  res.sendFile(`${ path }/dist/foo.js`);
});
```

To deploy:

```bash
npm version patch;
npm publish;
```

To activate:

```bash
npm dist-tag add my-live-updating-module@x.x.x release
```

`grabthar` will monitor and install anything passed in `tags`, but the activated version will only change when you set a new `release` dist tag.

## Rolling back to old versions

Just change the dist-tag to whatever version you want to roll back to:

```bash
npm dist-tag add my-live-updating-module@x.x.x latest
```

or:

```bash
npm dist-tag add my-live-updating-module@x.x.x release
```

## What else will `watcher.get()` return?

```javascript
const {

  // The root directory where the module is installed, e.g.
  // /Users/zippy/__live_modules__/my-live-updating-module_1.3.53 
  root,

  // The full path to your module, e.g.
  // /Users/zippy/__live_modules__/my-live-updating-module_1.3.53/node_modules/my-live-updating-module
  path,

  // The semver version of your module that is currently installed and activated, e.g.
  // 1.3.53
  version,

  // A map of the dependencies of your module, e.g.
  // { foo: '1.2.3', bar: '0.45.2' }
  dependencies

} = await watcher.get();
```

## How can I cancel a watcher?

```javascript
watcher.cancel();
```

### Tests

- Run the tests:

  ```bash
  npm test
  ```

