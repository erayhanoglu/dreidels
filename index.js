'use strict';
const readline = require('readline');
const colorette = require('colorette');
const cliCursor = require('cli-cursor');
const onExit = require('signal-exit')
const EventEmitter = require('events').EventEmitter;
const EOL = require('os').EOL;
const isPromise = require('is-promise');
const isObservable = require('is-observable');
const { dashes, dots } = require('./spinners');
const { writeStream, cleanStream, secondStageIndent, indentText, turnToValidSpinner, purgeSpinnerOptions, purgeSpinnersOptions, purgeStatusOptions, colorOptions, breakText, getLinesLength, terminalSupportsUnicode, isCI, isError, isValidPrefix, isValidColor } = require('./utils');

const DEFAULT_STATUS = 'spinning';

class StatusRegistry extends EventEmitter {
  constructor(defaultStatus) {
    super();

    this.defaultStatus = defaultStatus;
    this.statuses = {};
    this.statusesAliases = {};
  }

  configureStatus(name, statusOptions = {}) {
    if (!name) throw new Error('Status name must be a string');
    let { aliases } = statusOptions;
    const existingStatus = this.statuses[name] || {};
    const purgedOptions = purgeStatusOptions(statusOptions);

    const opts = {
      prefix: false,
      isStatic: false,
      noSpaceAfterPrefix: false,
      spinnerColor: 'cyan',
      prefixColor: 'cyan',
      textColor: false,
      ...existingStatus,
      ...purgedOptions
    }

    if (opts.isDone === undefined)  {
      opts.isDone = opts.isStatic;
    }

    if (this.statuses[name] === undefined) {
      this.emit('statusAdded', name);
    }
    this.statuses[name] = opts;

    if (aliases) {
      aliases = Array.isArray(aliases) ? aliases : [aliases];
      aliases.forEach(aliasName => {
        if (typeof aliasName !== 'string') return;

        if (this.statusesAliases[aliasName] === undefined) {
          this.emit('statusAdded', aliasName);
        }
        this.statusesAliases[aliasName] = name;
      });
    }

    return this;
  }

  getStatus(name) {
    const status = this.statuses[name];
    if (status) {
      return status;
    }

    const fromAlias = this.statusesAliases[name];
    if (fromAlias && this.statuses[fromAlias]) {
      return this.statuses[fromAlias];
    }

    return this.statuses[this.defaultStatus];
  }

  actualName(nameOrAlias) {
    if (this.statuses[nameOrAlias]) return nameOrAlias;
    return this.statusesAliases[nameOrAlias];
  }
};

class Spinnie extends EventEmitter {
  constructor({ name, options, inheritedOptions, statusRegistry, logs, stream }) {
    super();

    if (!options.text) options.text = name;
    const spinnerProperties = {
      ...colorOptions(inheritedOptions),
      succeedPrefix: inheritedOptions.succeedPrefix,
      failPrefix: inheritedOptions.failPrefix,
      status: 'spinning',
      hidden: false,
      ...purgeSpinnerOptions(options),
    };

    this.logs = logs;
    this.options = spinnerProperties;
    this.statusRegistry = statusRegistry;
    this.statusOverrides = {};
    this.stream = stream;

    Object.keys(this.statusRegistry.statuses).forEach(name => {
      this.aliasStatusAsMethod(name);
    });

    Object.keys(this.statusRegistry.statusesAliases).forEach(name => {
      this.aliasStatusAsMethod(name);
    });

    this.applyStatusOverrides(spinnerProperties);

    return this;
  }

  update(options = {}) {
    const { status } = options;
    const keys = Object.keys(options);
    if (keys.length === 1 && keys[0] === 'status') return this.status(status); // skip all options purging...

    this.setSpinnerProperties(options, status);
    this.updateSpinnerState();

    return this;
  }

  status(statusName) {
    if (!statusName || typeof statusName !== 'string') return this;
    this.options.status = statusName;
    this.updateSpinnerState();

    return this;
  }

  text(newText) {
    if (typeof newText !== 'string') return this;
    this.options.text = newText;
    this.updateSpinnerState();

    return this;
  }

  indent(newIndent) {
    if (typeof newIndent !== 'number') return this;
    this.options.indent = newIndent;
    this.updateSpinnerState();

    return this;
  }

  remove() {
    this.emit('removeMe');
  }

  hidden(bool) {
    if (typeof bool === 'boolean' && this.options.hidden !== bool) {
      this.options.hidden = bool;
      this.updateSpinnerState();
    }
    return this.options.hidden;
  }

  hide() {
    return this.hidden(true);
  }

  show() {
    return this.hidden(false);
  }

  bind(task) {
    if (isObservable(task)) {
      task = new Promise((resolve, reject) => {
        task.subscribe({
          next: (text) => {
            if (typeof text !== 'string') return;
            this.text(text);
          },
          error: reject,
          complete: resolve
        });
      });
    }

    if (isPromise(task)) {
      task.then((result) => {
        if (result && typeof result === 'string') {
          this.update({ status: 'success', text: result });
        } else {
          this.status('success');
        }
      }).catch((err) => {
        let message = false;

        if (typeof err === 'string') {
          message = err;
        } else if (isError(err)) {
          const color = this.getStatus('fail').textColor;
          const msg = err.message;
          const stack = err.stack.substring(err.stack.indexOf('\n') + 1);

          this.statusOverrides.fail.textColor = false; // to prevent spinnies from painting the text
          message = `${colorette[color](msg)}\n${colorette.gray(stack)}`;
        }

        if (message !== false) {
          this.update({ status: 'fail', text: message });
        } else {
          this.status('fail');
        }
      });
    }
  }

  applyStatusOverrides(opts) {
    const newOpts = {
      ...opts,
      successColor: opts.succeedColor,
      successPrefix: opts.succeedPrefix,
      spinningColor: opts.color
    }
    const statuses = ['success', 'fail', 'warn', 'info', 'spinning'];

    statuses.forEach(status => {
      const overrides = {};
      const prefix = newOpts[status + 'Prefix']
      const color = newOpts[status + 'Color']

      // Validate options
      if (isValidPrefix(prefix)) {
        overrides.prefix = prefix;
      }
      if (isValidColor(color)) {
        overrides.prefixColor = color;
        overrides.textColor = color;
      }

      // Spinner color exception
      if (status === 'spinning' && isValidColor(opts.spinnerColor)) {
        overrides.spinnerColor = opts.spinnerColor;
        overrides.prefixColor = opts.spinnerColor;
      }

      // Apply overrides
      const current = this.statusOverrides[status] || {};
      this.statusOverrides[status] = { ...current, ...overrides };
    })
  }

  isActive() {
    return !this.getStatus(this.options.status).isDone;
  }

  rawRender() {
    const status = this.getStatus(this.options.status);
    const text = this.options.text;
    const renderedPrefix = `${status.prefix ? ((status.prefixColor ? colorette[status.prefixColor](status.prefix) : status.prefix) + (status.noSpaceAfterPrefix ? '' : ' ')) : ''}`;
    let output = `${renderedPrefix}${status.textColor ? colorette[status.textColor](text) : text}`;

    const indent = this.options.indent;
    let prefixLengthToIndent = 0;
    if (status.prefix) {
      // only if we have a prefix...
      prefixLengthToIndent = status.prefix.length;
      if (!status.noSpaceAfterPrefix) {
        // if we have a space after the prefix add 1 to the prefix length
        prefixLengthToIndent += 1;
      }
    }

    output = breakText(output, 0, indent, this.stream);
    output = indentText(output, prefixLengthToIndent, indent);
    output = secondStageIndent(output, indent);

    return output;
  }

  render(frame) {
    let { text, status, indent } = this.options;
    const statusOptions = this.getStatus(status);
    let line;
    let prefix = '';

    if (!statusOptions.isStatic) {
      prefix = frame;
      if (!statusOptions.noSpaceAfterPrefix) {
        prefix += ' ';
      }
    } else if (statusOptions.prefix) {
      prefix = statusOptions.prefix;
      if (!statusOptions.noSpaceAfterPrefix) {
        prefix += ' ';
      }
    }
    const prefixLength = prefix.length;
    const textColor = statusOptions.textColor;
    const prefixColor = statusOptions.isStatic ? statusOptions.prefixColor : statusOptions.spinnerColor;

    text = breakText(text, prefixLength, indent, this.stream);
    text = indentText(text, prefixLength, indent);
    line = `${prefixLength ? (prefixColor ? colorette[prefixColor](prefix) : prefix) : ''}${textColor ? colorette[textColor](text) : text}`;
    line = secondStageIndent(line, indent);

    return line;
  }

  addLog(log) {
    this.logs.push(log);
  }

  getStatus(name) {
    const override = this.statusOverrides[this.statusRegistry.actualName(name)] || {};
    return { ...this.statusRegistry.getStatus(name), ...override };
  }

  setSpinnerProperties(options, status) {
    this.applyStatusOverrides(options);
    options = purgeSpinnerOptions(options);
    status = status || this.options.status || 'spinning';

    this.options = { ...this.options, ...options, status };
    return this;
  }

  aliasStatusAsMethod(name) {
    if (this[name] !== undefined) return;

    this[name] = (options) => this.update({ ...options, status: name });
  }

  updateSpinnerState() {
    this.emit('updateSpinnerState');
  }
}

class Spinnies {
  constructor(options = {}) {
    options = purgeSpinnersOptions(options);
    this.options = {
      color: 'white',
      spinnerColor: 'greenBright',
      succeedColor: 'green',
      failColor: 'red',
      warnColor: 'yellow',
      infoColor: 'blue',
      spinner: terminalSupportsUnicode() ? dots : dashes,
      disableSpins: false,
      stream: process.stderr,
      ...options
    };

    this.logs = [];
    this.spinners = {};
    this.statusRegistry = new StatusRegistry(DEFAULT_STATUS);

    this.isCursorHidden = false;
    this.currentInterval = null;
    this.stream = this.options.stream;
    this.lineCount = 0;
    this.currentFrameIndex = 0;
    this.spin = !this.options.disableSpins && !isCI && this.stream && this.stream.isTTY;

    this.statusRegistry.on('statusAdded', name => {
      Object.values(this.spinners).forEach(spinner => {
        spinner.aliasStatusAsMethod(name);
      });
      this.aliasChildMethod(name);
    });

    this.statusRegistry.configureStatus('spinning', {
      aliases: ['spin', 'active', 'default'],
      spinnerColor: this.options.color,
      textColor: this.options.color,
      prefix: '-',
      prefixColor: this.options.color
    });
    this.statusRegistry.configureStatus('success', {
      aliases: ['succeed', 'done'],
      prefix: this.options.succeedPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.succeedColor,
      textColor: this.options.succeedColor
    });
    this.statusRegistry.configureStatus('fail', {
      aliases: ['failed', 'error'],
      prefix: this.options.failPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.failColor,
      textColor: this.options.failColor
    });
    this.statusRegistry.configureStatus('warn', {
      aliases: 'warning',
      prefix: this.options.warnPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.warnColor,
      textColor: this.options.warnColor
    });
    this.statusRegistry.configureStatus('info', {
      aliases: 'information',
      prefix: this.options.infoPrefix,
      isStatic: true,
      noSpaceAfterPrefix: false,
      prefixColor: this.options.infoColor,
      textColor: this.options.infoColor
    });
    this.statusRegistry.configureStatus('non-spinnable', {
      aliases: ['static', 'inactive'],
      prefix: false,
      isStatic: true
    });
    this.statusRegistry.configureStatus('stopped', {
      aliases: ['stop', 'cancel'],
      prefix: false,
      isStatic: true,
      textColor: 'gray'
    });

    ['update', 'status', 'setSpinnerProperties', 'hidden', 'hide', 'show', 'text', 'indent', 'bind'].forEach(method => {
      this.aliasChildMethod(method);
    });

    this.bindExitEvent();
  }

  addLog(str) {
    this.logs.push(str);
  }

  get(name) {
    if (typeof name !== 'string') throw new Error('A spinner reference name must be specified');
    if (!this.spinners[name]) throw new Error(`No spinner initialized with name ${name}`);
    return this.spinners[name];
  }

  pick(name) {
    return this.get(name).options;
  }

  setFrames(frames) {
    const spinner = turnToValidSpinner(frames);
    this.options.spinner = spinner;
    this.currentFrameIndex = 0;
    this.updateSpinnerState();

    return this;
  }

  add(name, options = {}) {
    if (typeof name !== 'string') throw new Error('A spinner reference name must be specified');
    if (this.spinners[name] !== undefined) throw new Error(`A spinner named '${name}' already exists`);

    const spinnie = new Spinnie({ name, options, stream: this.stream, inheritedOptions: this.options, statusRegistry: this.statusRegistry, logs: this.logs });

    spinnie.on('removeMe', () => {
      this.remove(name);
    }).on('updateSpinnerState', () => {
      this.updateSpinnerState(name);
    });

    this.spinners[name] = spinnie;

    this.updateSpinnerState(name);

    return spinnie;
  }

  remove(name) {
    if (typeof name !== 'string') throw new Error('A spinner reference name must be specified');
    if (!this.get(name)) throw new Error(`No spinner initialized with name ${name}`);

    this.get(name).removeAllListeners();
    delete this.spinners[name];
    this.updateSpinnerState();
  }

  stopAll(newStatus = 'stopped') {
    if (this.statusRegistry.actualName(newStatus) === undefined) newStatus = 'stopped';
    Object.keys(this.spinners).forEach(name => {
      const currentSpinner = this.get(name);
      const currentStatus = currentSpinner.getStatus(currentSpinner.options.status);
      if (!currentStatus.isDone) {
        currentSpinner.options.status = newStatus;
      }
    });
   
    return this.spinners;
  }

  hasActiveSpinners() {
    return !!Object.values(this.spinners).find((spinner) => spinner.isActive());
  }

  updateSpinnerState(name) {
    if (this.spin) {
      clearInterval(this.currentInterval);
      this.currentInterval = this.loopStream();
      if (!this.isCursorHidden) cliCursor.hide();
      this.isCursorHidden = true;     
    } else {
      if (!name) return;
      const spinner = this.get(name);

      if (spinner.hidden()) return;
      this.stream.write(spinner.rawRender() + EOL);
    }
  }

  loopStream() {
    const { frames, interval } = this.options.spinner;
    return setInterval(() => {
      this.setStreamOutput(frames[this.currentFrameIndex]);
      this.currentFrameIndex = this.currentFrameIndex === frames.length - 1 ? 0 : ++this.currentFrameIndex;
      this.checkIfActiveSpinners();
    }, interval);
  }

  setStreamOutput(frame = '') {
    let output = '';
    const linesLength = [];
    const hasActiveSpinners = this.hasActiveSpinners();
    Object
      .values(this.spinners)
      .filter(spinner => !spinner.hidden())
      .forEach((spinner) => {
        const lines = spinner.render(frame);
        const length = getLinesLength(lines);

        linesLength.push(...length);
        output += lines + EOL;
      });

    if (!hasActiveSpinners) readline.clearScreenDown(this.stream);
    writeStream(this.stream, output, linesLength);
    if (hasActiveSpinners) cleanStream(this.stream, linesLength);
    this.lineCount = linesLength.length;
  }

  checkIfActiveSpinners() {
    if (!this.hasActiveSpinners()) {
      if (this.spin) {
        this.setStreamOutput();
        readline.moveCursor(this.stream, 0, this.lineCount);
        clearInterval(this.currentInterval);
        this.isCursorHidden = false;
        cliCursor.show();
      }
      this.spinners = {};
      this.removeExitListener();
    }
  }

  aliasChildMethod(method) {
    if (this[method] !== undefined) return;

    this[method] = (name, ...args) => {
      const spinner = this.get(name);
      return spinner[method](...args);
    };
  }

  bindExitEvent() {
    this.removeExitListener = onExit(() => {
      // cli-cursor will automatically show the cursor...
      readline.moveCursor(this.stream, 0, this.lineCount);
    }, { alwaysLast: true });
  }

  log(method = console.log) {
    this.logs.forEach((log) => method(log));
  }

  getLogs() {
    return this.logs;
  }
}

module.exports = Spinnies;
module.exports.dots = dots;
module.exports.dashes = dashes;
module.exports.StatusRegistry = StatusRegistry;
