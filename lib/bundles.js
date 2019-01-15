/*! bundles.js | @author brikcss <https://github.com/brikcss> | @reference https://github.com/bundles */

// -------------------------------------------------------------------------------------------------
// Set up environment.
//
const path = require('path')
const fs = require('fs-extra')
const globby = require('globby')
const matter = require('gray-matter')

// -------------------------------------------------------------------------------------------------
// Main functions.
//

function compile (config = {}, runOptions = {}) {
  // Get config file and merge with user config.
  return resolveConfig(config, runOptions)
    .then(runBundles)
    .then(createWatchers)
    .then(prepResults)
    .catch(throwError)
}

function resolveConfig (config = {}, runOptions = {}) {
  return new Promise((resolve, reject) => {
    let configFile = false

    // Fetch config filepath.
    if (typeof config === 'string') {
      const cosmiconfig = require('cosmiconfig')('bundles')
      config = config.split(':')
      runOptions.bundles = runOptions.bundles || config[1] || undefined
      if (
        runOptions.bundles !== 'all' &&
        typeof runOptions.bundles === 'string'
      ) runOptions.bundles = runOptions.bundles.split(/,?\s+/)
      config = config[0]
      config = fs.pathExistsSync(config) ? cosmiconfig.loadSync(config) : cosmiconfig.searchSync(config)
      if (config === null) return reject(new Error('Config file was not found.'))
      configFile = config.filepath
      config = config.config
    }

    // If config is an Object with `input` and `bundlers` props, set it as a bundle.
    if (config.input && config.bundlers) config = { bundles: [config] }

    // Merge config with defaults and runOptions with config.options.
    // NOTE: All defaults should be listed here to show them in one place.
    config = Object.assign({
      success: false,
      bundles: [],
      bundlesMap: {},
      options: {},
      watchers: {},
      on: {}
    }, config, {
      options: runOptions,
      _meta: {
        configFile,
        createdWatchers: false
      }
    })

    // Normalize all bundles on first compile. Only normalize one bundle on a rebundle.
    config.bundles = normalizeBundles(config.bundles, config.options)

    // Return resolved config.
    return resolve(config)
  })
}

function runBundles (config = {}) {
  const promises = []
  // Run each bundle that is valid and configured to run in `options.bundles`.
  config.bundles.forEach((bundle, i) => {
    if (
      bundle._meta.isValid &&
      (!config.options.bundles || config.options.bundles.includes(bundle.id))
    ) {
      promises.push(runBundle(bundle))
    } else {
      bundle.success = 'skipped'
      promises.push(bundle)
    }
  })
  return Promise.all(promises).then(bundles => {
    config.bundles = bundles
    return config
  })
}

function createWatchers (config = {}) {
  // Only continue if watchers haven't already been created.
  if (config._meta.createdWatchers) return config
  config._meta.createdWatchers = true

  // Convert options.watch to Boolean or String[].
  if (typeof config.options.watch === 'string') config.options.watch = config.options.watch.split(/,?\s+/)
  // If options.watch is explicitly set to false, don't do anything.
  if (config.options.watch === false) return config
  // Otherwise make sure `options.watch` is a Boolean if it's not already an String[].
  else if (!(config.options.watch instanceof Array)) config.options.watch = Boolean(config.options.watch)

  // Iterate through bundles and create a watcher for each as configured.
  const chokidar = require('chokidar')
  const promises = []
  config.bundles.forEach((bundle, i) => {
    // If the bundle is not configured to be watched, or if a watcher already exists, skip it.
    if (!bundle.watch &&
      (
        !config.options.watch ||
        (config.options.watch instanceof Array &&
        config.options.watch.includes(bundle.id))
      ) &&
      !config.watchers[bundle.id]
    ) { return }
    // Create a watcher for this bundle.
    promises.push(new Promise((resolve, reject) => {
      const watcher = chokidar.watch(bundle.output.map(file => file.source.path), typeof bundle.watch === 'object' ? bundle.watch : {})
      watcher
        .on('change', (filepath) => {
          if (!bundle._meta.isWatching) return
          return compile(config, { rebundle: bundle.id }).then(result => {
            let currentBundle = result.bundlesMap[bundle.id]
            if (typeof config.on.afterChange === 'function') currentBundle = config.on.afterChange(currentBundle, { filepath, config })
            if (typeof currentBundle.on.afterChange === 'function') currentBundle = currentBundle.on.afterChange(currentBundle, { filepath, config })
            return result
          })
        })
        .on('error', reject)
        .on('ready', () => {
          bundle._meta.isWatching = true
          resolve()
        })
      // Add watcher to config.
      watcher.id = bundle.id
      config.watchers[bundle.id] = watcher
    }))
  })

  // Return config.
  return Promise.all(promises).then(() => config)
}

function prepResults (config = {}) {
  config.success = !config.bundles.some(bundle => !bundle._meta.isValid || !bundle.success)
  config.bundlesMap = {}
  config.bundles.forEach((bundle, i) => {
    config.bundlesMap[bundle.id] = config.bundles[i]
  })
  return config
}

// -------------------------------------------------------------------------------------------------
// Helper functions.
//

function runBundle (bundle = {}) {
  return bundle.bundlers.reduce((promise, bundler, i) => {
    return promise.then((result) => {
      const bundlerResult = bundler.run(result, bundler)
      bundler.success = true
      return bundlerResult
    }).catch(error => {
      bundler.success = false
      bundler.error = error
      return bundle
    })
  }, Promise.resolve(bundle)).then(result => {
    result.success = result.bundlers.every(bundler => bundler.success)
    return result
  }).catch(error => {
    bundle.success = false
    bundle.error = error
    return bundle
  })
}

function normalizeBundles (bundles = [], options = {}) {
  // Ensure bundles is an Array.
  if (bundles instanceof Object && bundles.constructor === Object) bundles = [bundles]
  if (!(bundles instanceof Array)) throwError('`config.bundles` must be an Array.')
  // Normalize each bundle.
  return bundles.map((bundle, bundleIndex) => {
    if (!options.rebundle || bundle.id === options.rebundle) return normalizeBundle(bundle, options, bundleIndex)
  })
}

function normalizeBundle (bundle = {}, options = {}, index) {
  // Ensure bundle is an Object and is a valid bundle.
  if (!(bundle instanceof Object)) bundle = { _meta: { isValid: false } }

  // Normalize bundle with defaults.
  bundle = Object.assign({
    id: String(index),
    input: [],
    output: [],
    bundlers: [],
    watch: Boolean(options.watch || bundle.watch),
    on: {},
    _meta: {}
  }, bundle)

  // Normalize input.
  if (typeof bundle.input === 'string') bundle.input = bundle.input.split(/,?\s+/)
  if (!(bundle.input instanceof Array)) bundle.input = [bundle.input]
  bundle.input = globby.sync(bundle.input, Object.assign({ dot: true }, options.glob || {}))

  // Create initial result from input.
  bundle.input.forEach((filepath, i) => {
    bundle.output[i] = readFile(filepath, options.frontMatter || {})
  })

  // Normalize bundlers.
  if (typeof bundle.bundlers === 'string') bundle.bundlers = bundle.bundlers.split(/,?\s+/)
  bundle.bundlers = bundle.bundlers.map(bundler => resolveBundler(bundler, bundle))

  // Make sure bundle is valid.
  bundle._meta.isValid = isValidBundle(bundle)

  // Return the bundle.
  return bundle
}

function readFile (filepath, options = {}) {
  const file = {}
  file.source = matter.read(filepath, options)
  file.source.path = path.normalize(filepath)
  file.content = file.source.excerpt + file.source.content
  file.data = file.source.data
  return file
}

function resolveBundler (bundler, bundle) {
  // Normalize bundler to an Object: { run }.
  if (!(bundler instanceof Object) || bundler.constructor !== Object) bundler = { run: bundler }
  bundler._meta = bundler._meta || {}
  bundler._meta.isValid = true
  bundler.success = false

  // Validate bundler.run.
  if (typeof bundler.run === 'function') return bundler
  if (!bundler.run || typeof bundler.run !== 'string') {
    bundler._meta.isValid = false
    return bundler
  }

  // If bundler.run is a relative path, resolve the path.
  if (bundler.run.indexOf('./') === 0 || bundler.run.indexOf('../') === 0) {
    bundler.run = path.resolve(bundler.run)
  }

  // Check for prefixed `bundles-` version of the module. If it doesn't exist, use given path.
  if (path.basename(bundler.run).indexOf('bundles-') === -1) {
    const prefixedPath = path.join(path.dirname(bundler.run), 'bundles-' + path.basename(bundler.run))
    try {
      if (require.resolve(prefixedPath)) bundler.run = prefixedPath
    } catch (error) {}
  }

  // Require module.
  try {
    bundler.run = require(bundler.run)
  } catch (error) {
    bundler._meta.isValid = false
    bundler.error = error
    return bundler
  }

  // At this point if bundler.run is not a function, skip it.
  if (typeof bundler.run !== 'function') {
    bundler._meta.isValid = false
  }

  // Return the bundler Object.
  return bundler
}

function isValidBundle (bundle = {}) {
  return bundle instanceof Object &&
    (bundle.input instanceof Array) &&
    (bundle.input.every(input => typeof input === 'string')) &&
    (bundle.bundlers instanceof Array) &&
    bundle.bundlers.length &&
    bundle.bundlers.some(bundler => bundler._meta.isValid)
}

function throwError (error = 'Uh oh...') {
  throw new Error(error)
}

// -------------------------------------------------------------------------------------------------
// Exports.
//

module.exports = compile