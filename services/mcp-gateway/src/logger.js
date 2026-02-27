const level_priority = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

class Logger {
  constructor(log_level = "info") {
    this.log_level = log_level;
  }

  should_log(level_name) {
    const configured_priority = level_priority[this.log_level] ?? level_priority.info;
    const message_priority = level_priority[level_name] ?? level_priority.info;
    return message_priority >= configured_priority;
  }

  write(level_name, message_text, metadata = {}) {
    if (!this.should_log(level_name)) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level: level_name,
      message: message_text,
      ...metadata
    };

    const output_line = JSON.stringify(payload);

    if (level_name === "error") {
      console.error(output_line);
      return;
    }

    console.log(output_line);
  }

  debug(message_text, metadata = {}) {
    this.write("debug", message_text, metadata);
  }

  info(message_text, metadata = {}) {
    this.write("info", message_text, metadata);
  }

  warn(message_text, metadata = {}) {
    this.write("warn", message_text, metadata);
  }

  error(message_text, metadata = {}) {
    this.write("error", message_text, metadata);
  }
}

export { Logger };
