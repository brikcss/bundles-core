/*! bundle.js | @author brikcss <https://github.com/brikcss> | @reference https://github.com/brikcss/bundles-core */

// -------------------------------------------------------------------------------------------------
// Imports and environment setup.
//

import log from 'loglevel'
import merge from '@brikcss/merge'
import path from 'path'
import chokidar from 'chokidar'
import Bundler from './bundler.js'
import File from './file.js'
import { defaultOptions } from './config.js'
import _ from './utilities.js'

// Cache cwd.
const cwd = process.cwd()
// Cache next id for bundles that don't have an ID already.
let nextId = 0

// -------------------------------------------------------------------------------------------------
// Bundler constructor and prototype.
//

Bundle.prototype = {
  /**
   * Whether a bundle is configured to be run.
   *
   * @return  {Boolean}  Whether Bundle ID should be run.
   */
  shouldRun () {
    return _.idExistsInValue(this.options.run, this.id)
  },
  /**
   * Whether a bundle is configured to be watched.
   *
   * @return  {Boolean}  Whether Bundle ID should be watched.
   */
  shouldWatch () {
    return _.idExistsInValue(this.options.watch, this.id)
  },

  /**
   * Run a single bundle.
   *
   * @return {Object}  Compiled bundle.
   */
  run ({ start = new Date() } = {}) {
    const bundle = this

    // Do not run it if it's invalid.
    if (!bundle.valid) {
      bundle.success = false
      return Promise.resolve(bundle)
    }

    // Only continue if configured to do so.
    if (!bundle.shouldRun()) {
      bundle.success = 'skipped'
      return Promise.resolve(bundle)
    }

    // Reduce bundlers to a series of promises that run in order.
    return bundle.bundlers.reduce((promise, bundler, i) => {
      return promise.then((bundle) => {
        return bundler.run(bundle, bundler)
      // If bundler completes successfully, mark as success.
      }).then(bundle => {
        bundler.success = true
        return bundle
      // If bundler errors out, mark as such and log the error.
      }).catch(error => {
        bundler.success = false
        log.error(`Error on [${bundle.id}|${i}]...\n`, error)
        return bundle
      })
    // A bundle is marked as successful if all bundlers successfully complete.
    }, Promise.resolve(bundle)).then(bundle => {
      bundle.success = bundle.bundlers.every(bundler => bundler.success)
      if (bundle.success) {
        bundle.changed = []
        bundle.removed = []
      }
      log.info(`${bundle.watching ? 'Rebundled' : 'Bundled'} [${bundle.id}] (${_.getTimeDiff(start)})`)
      return bundle.watch()
    // If a bundle errors out, mark it and log error.
    }).catch(error => {
      bundle.success = false
      log.error(`Error on [${bundle.id}]...`, error)
      return bundle
    })
  },

  update (filepaths, rebundle = true) {
    const bundle = this
    const start = new Date()
    // Ensure filepaths is an array.
    if (_.trueType(filepaths) !== 'array') filepaths = [filepaths]
    // Iterate through filepaths and add to bundle.output, bundle.outputMap, and bundle.changed.
    filepaths.forEach(filepath => {
      // Log the file change.
      log.info(`File changed: ${path.relative(cwd, filepath)}`)
      // Read in changed source file, if it exists in the output dictionary.
      if (bundle.outputMap[filepath]) {
        bundle.outputMap[filepath] = Object.assign(bundle.outputMap[filepath], new File(filepath, bundle))
        bundle.changed.push(bundle.outputMap[filepath])
      // If changed file exists in watchFiles, mark all output files as changed.
      } else if (bundle.options.watchFiles.length && bundle.options.watchFiles.includes(filepath)) {
        bundle.output.forEach((f, i) => {
          bundle.output[i] = new File(bundle.output[i].source.path, bundle)
          bundle.changed.push(bundle.output[i])
        })
      // If it's a bundler file, refresh the bundler.
      } else if (bundle.modules.length && bundle.modules.includes(filepath)) {
        let bundlerIndex = bundle.bundlers.findIndex((b, i) => b.id === filepath)
        delete require.cache[filepath]
        bundle.bundlers[bundlerIndex].run = _.requireModule(filepath)
        bundle.output.forEach(file => {
          file.content = file.source.content
        })
        bundle.changed = bundle.output
      }
    })
    // Run bundle.
    return rebundle ? bundle.run({ start }) : Promise.resolve(bundle)
  },

  /**
   * Add one or more files to the bundle.
   *
   * @param {String|String[]} filepaths  Files to add.
   * @param {boolean} [rebundle=true]  Whether to rebundle after removing.
   * @return {Promise}  Promise to return the bundle.
   */
  addFile (filepaths, rebundle = true) {
    const bundle = this
    const start = new Date()
    // Ensure filepaths is an array.
    if (_.trueType(filepaths) !== 'array') filepaths = [filepaths]
    // Iterate through filepaths and add to bundle.output, bundle.outputMap, and bundle.changed.
    filepaths.forEach(filepath => {
      log.info(`File added: ${path.relative(cwd, filepath)}`)
      bundle.output.push(new File(filepath, bundle))
      const lastOutput = bundle.output[bundle.output.length - 1]
      bundle.outputMap[filepath] = lastOutput
      bundle.changed.push(lastOutput)
    })
    // Rebundle and/or return the bundle.
    return rebundle ? bundle.run({ start }) : Promise.resolve(bundle)
  },

  /**
   * Remove one or more files from the bundle.
   *
   * @param {String|String[]} filepaths  Files to remove.
   * @param {Boolean} [rebundle=true]  Whether to rebundle after removing.
   * @return {Promise}  Promise to return the bundle.
   */
  removeFile (filepaths, rebundle = true) {
    const bundle = this
    const start = new Date()
    // Ensure filepaths is an array.
    if (_.trueType(filepaths) !== 'array') filepaths = [filepaths]
    // Remove filepaths from bundle.output, bundle.outputMap, and bundle.changed.
    filepaths.forEach(filepath => {
      log.info(`File removed: ${path.relative(cwd, filepath)}`)
      bundle.removed.push(Object.assign({}, bundle.outputMap[filepath]))
      delete bundle.outputMap[filepath]
      bundle.output.splice(bundle.output.findIndex(f => f.source.path === filepath), 1)
      bundle.input.splice(bundle.input.findIndex(f => f === filepath), 1)
    })
    // Rebundle and/or return the bundle.
    return rebundle ? bundle.run({ start }) : Promise.resolve(bundle)
  },

  /**
   * Watch bundle and recompile when source input changes.
   *
   * @return {Promise}  Promise for compiled bundle.
   */
  watch () {
    const bundle = this
    if (bundle.watching) return Promise.resolve(bundle)

    // Return a promise.
    return new Promise((resolve, reject) => {
      // Only watch if it's configured to be watched.
      if (!bundle.shouldWatch()) {
        bundle.watching = false
        return resolve(bundle)
      }

      // Create watcher.
      bundle.watcher = chokidar.watch(bundle.watchInput.concat(bundle.options.watchFiles || [], bundle.modules), bundle.options.chokidar)

      // Add watcher events.
      bundle.watcher
        .on('add', (filepath) => bundle.watching && bundle.addFile(filepath))
        .on('change', (filepath) => bundle.watching && bundle.update(filepath))
        .on('unlink', (filepath) => bundle.watching && bundle.removeFile(filepath))
        .on('error', reject)
        .on('ready', () => {
          // Flag bundle and notify user.
          bundle.watching = true
          // Call the on.watching() hook.
          if (typeof bundle.on.watching === 'function') bundle.on.watching(bundle)
          return resolve(bundle)
        })

      // Watch config/data files.
      if (bundle.dataFiles) {
        bundle.watchDataFiles()
      }
    })
  }
}

/**
 * Bundle constructor.
 *
 * @param {Object} config  Bundle configuration.
 * @param {Object} globals  Bundles global configuration.
 */
function Bundle ({ id, input, bundlers, options, data, on } = {}, globals = {}) {
  //
  // Set defaults and normalize.
  // -------------
  // Set internal props.
  this.valid = false
  this.success = false
  this.watching = false
  this.watcher = null
  this.changed = []
  this.removed = []
  this.output = []
  this.watchInput = []
  this.modules = []

  // Set user configurable props.
  this.id = ((typeof id === 'number' || typeof id === 'string') ? id : nextId++).toString()
  this.input = input || []
  this.bundlers = bundlers || []

  // Merge options.
  this.options = merge([{}, defaultOptions, globals.options || {}, options || {}], { arrayStrategy: 'overwrite' })

  // Merge on hooks.
  this.on = Object.assign(on || {}, globals.on || {})

  // Merge global data with bundle data.
  if (!data || (!_.isObject(data) && typeof data !== 'function')) data = {}
  if (!globals.data || (!_.isObject(globals.data) && typeof globals.data !== 'function')) globals.data = {}
  if (typeof data === 'function' || typeof globals.data === 'function') {
    this.data = (file) => {
      return merge([
        {},
        typeof globals.data === 'function' ? globals.data(file) : globals.data,
        typeof data === 'function' ? data(file) : data
      ], { arrayStrategy: 'overwrite' })
    }
  } else {
    this.data = merge([{}, globals.data, data], { arrayStrategy: 'overwrite' })
  }

  // Convert input to an Array.
  if (typeof this.input === 'string' || _.isObject(this.input)) {
    this.input = [this.input]
  }
  if (_.trueType(this.input) !== 'array') return
  // Cache the original input sources as an Array so the watcher can watch globs.
  this.watchInput = this.input.reduce((result, item) => {
    const type = _.trueType(item)
    if (type === 'object' && item.path) result.push(item.path)
    if (type === 'string' || type === 'array') result.push(item)
    return result
  }, [])
  // Use options.cwd on options.glob.cwd.
  if (this.options && this.options.glob && !this.options.glob.cwd) this.options.glob.cwd = this.options.cwd

  //
  // Resolve input and output files.
  // -------------------------------
  const files = resolveFiles(this.input, this)
  this.input = files.input
  this.output = files.output
  this.outputMap = files.outputMap

  //
  // Create bundlers.
  // ----------------
  this.bundlers = this.bundlers.map(bundler => new Bundler(bundler, this))

  //
  // Check if bundle is valid.
  // -------------------------
  // A valid bundle is:
  //  - output is a non-empty [].
  //  - bundlers is a non-empty [] with at least one valid bundler.
  // -------------------------
  this.valid = this.input instanceof Array &&
    this.output instanceof Array &&
    this.output.length > 0 &&
    this.bundlers instanceof Array &&
    this.bundlers.length > 0 &&
    this.bundlers.some(bundler => bundler.valid)
}

// -------------------------------------------------------------------------------------------------
// Helper functions.
//

/**
 * Resolve Files from an input Array.
 * @param  {Array}  input  Array of paths or Objects to resolve.
 * @param  {Object}  bundle  Bundle configuration.
 * @return {Object}       Result = { input, output, outputMap }
 */
function resolveFiles (input = [], bundle = {}) {
  // Create initial result Object.
  let result = {
    input: [],
    output: [],
    outputMap: {}
  }
  // Make sure input is an Array.
  if (!(input instanceof Array)) input = [input]
  // Iterate through the input files and resolve all input/output files.
  return input.reduce((result, srcFile, i) => {
    const files = File.create(srcFile, bundle)
    files.forEach((file, i) => {
      const src = path.relative(cwd, path.join(bundle.options.cwd, file.source.path))
      result.output.push(file)
      result.input.push(src)
      if (!result.outputMap[file.source.path]) result.outputMap[file.source.path] = result.output[i]
    })
    return result
  }, result)
}

// -------------------------------------------------------------------------------------------------
// Exports.
//

export default Bundle
