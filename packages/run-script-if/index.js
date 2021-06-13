#!/usr/bin/env node

/*
 * Copyright 2021 Red Hat, Inc. and/or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { spawn } = require("child_process");

async function main() {
  const argv = yargs(hideBin(process.argv))
    .strict()
    .options({
      env: {
        type: "string",
        description: "Environment variable name",
      },
      bool: {
        type: "string",
        description: "Boolean value to be used as condition",
      },
      eq: {
        default: "true",
        alias: "equals",
        type: "string",
        description: "Value to be compared with the environment variable.",
      },
      then: {
        array: true,
        required: true,
        type: "string",
        description: "Command(s) to execute if environment variable has the desired value",
      },
      else: {
        default: [],
        array: true,
        required: false,
        type: "string",
        description: "Command(s) to execute if environment variable doesn't have the desired value",
      },
      "true-if-empty": {
        default: false,
        type: "boolean",
        description: "If the environment variable is not set, the command(s) supplied to --then will run.",
      },
      silent: {
        default: false,
        type: "boolean",
        description: "Hide logs from output.",
      },
      force: {
        default: false,
        type: "boolean",
        description: "Runs command(s) supplied to --then regardless of the environment variable value.",
      },
      catch: {
        default: [],
        array: true,
        required: false,
        type: "string",
        description: "Command(s) to execute at the end of execution if one of the commands being executed fails.",
      },
      finally: {
        default: [],
        array: true,
        required: false,
        type: "string",
        description:
          "Command(s) to execute at the end of execution. Provided commands will run even if one of the commands being executed fails.",
      },
    })
    .check((argv, options) => {
      if (argv.bool && argv.env) {
        throw new Error("Conditions must either be --bool or --env");
      }

      if (argv.bool !== "true" && argv.bool !== "false") {
        throw new Error(
          `Boolean condition provided, but value is '${argv.bool}'. Boolean condition values must be either 'true' or 'false'.`
        );
      }

      if (argv.bool && argv["true-if-empty"]) {
        throw new Error("Conditions with --bool cannot be used with --true-if-empty");
      }

      if (!(argv.bool || argv.env)) {
        throw new Error("Conditions must be either --bool or --env");
      }

      return true;
    }).argv;

  const log = (logFunction, ...args) => {
    if (!argv.silent) {
      logFunction(`[run-script-if]`, ...args);
    }
  };

  const envVarName = argv.env;
  const envVarValue = process.env[envVarName];
  const shouldRunIfEmpty = argv["true-if-empty"];

  const condition =
    // --bool conditions are true if equals to --eq
    argv.bool === argv.eq ||
    // env var value is logically empty and --true-if-empty is enabled
    ((envVarValue === undefined || envVarValue === "") && shouldRunIfEmpty) ||
    // env var value is equal to the --eq argument
    envVarValue === argv.eq ||
    // env var value is ignored and the --then commands are executed
    argv.force;

  const commandStringsToRun = condition ? argv.then : argv.else;

  if (envVarName) log(console.info, LOGS.envVarSummary(envVarName, envVarValue));
  if (argv.bool) log(console.info, LOGS.boolSummary());
  if (shouldRunIfEmpty) log(console.info, LOGS.trueIfEmptyEnabled());
  if (argv.force) log(console.info, LOGS.forceEnabled());
  log(console.info, LOGS.conditionSummary(condition));

  await runCommandStrings(log, argv, commandStringsToRun)
    .catch(async (e) => {
      if (e.msg) {
        console.error(e.msg);
      }

      const catchCommands = argv.catch;
      if (catchCommands.length <= 0) {
        throw e;
      }

      log(console.error, LOGS.runningCatchCommands());
      await runCommandStrings(log, argv, catchCommands).catch((err) => {
        console.error(err.msg);
      });

      throw e;
    })
    .finally(async () => {
      let finallyCommands = argv.finally;
      if (finallyCommands.length <= 0) {
        return;
      }

      log(console.error, LOGS.runningFinallyCommands());
      await runCommandStrings(log, argv, finallyCommands).catch((err) => {
        console.error(err.msg);
      });
    });
}

async function runCommandStrings(log, argv, commandStringsToRun) {
  if (commandStringsToRun.length > 0) {
    log(console.info, LOGS.running(commandStringsToRun));
  } else {
    log(console.info, LOGS.runningZero());
  }

  let nCommandsFinished = 0;
  for (const runningCommandString of commandStringsToRun) {
    await new Promise((res, rej) => {
      log(console.info, LOGS.runningCommand(runningCommandString));
      const command = spawnCommandString(runningCommandString);

      command.on("error", (data) => {
        logCommandError(log, commandStringsToRun, nCommandsFinished, runningCommandString);
        rej({ code: 1, msg: data.toString() });
      });

      command.on("exit", (code) => {
        if (code !== 0) {
          logCommandError(log, commandStringsToRun, nCommandsFinished, runningCommandString);
          rej({ code });
          return;
        }

        nCommandsFinished += 1;
        log(console.info, LOGS.finishCommand(runningCommandString));
        res();
      });
    });
  }
}

function spawnCommandString(commandString) {
  const bin = commandString.split(" ")[0];
  const args = commandString
    .split(" ")
    .slice(1)
    .filter((arg) => arg.trim().length > 0);
  const shell = process.platform === "win32" ? { shell: "powershell.exe" } : {};
  return spawn(bin, args, { stdio: "inherit", ...shell });
}

function logCommandError(log, commandStringsToRun, nCommandsFinished, runningCommandString) {
  const commandsLeft = commandStringsToRun.length - nCommandsFinished - 1;
  if (commandsLeft > 0) {
    const skippedCommands = commandStringsToRun.splice(nCommandsFinished + 1);
    log(console.error, LOGS.errorOnMiddleCommand(runningCommandString, commandsLeft, skippedCommands));
  } else {
    log(console.error, LOGS.errorOnLastCommand(runningCommandString));
  }
}

const LOGS = {
  runningCommand: (commandString) => {
    return `Running '${commandString}'`;
  },
  runningZero: () => {
    return `No commands to run.`;
  },
  runningFinallyCommands: () => {
    return `Execution finished. Running _finally_ command(s).`;
  },
  runningCatchCommands: () => {
    return `There are errors. Running _catch_ command(s).`;
  },
  finishCommand: (commandString) => {
    return `Finished '${commandString}'`;
  },
  errorOnLastCommand: (cmd) => {
    return `Error executing '${cmd}'.`;
  },
  skipping: (commandStrings) => {
    return `Skipping ${commandStrings.length} command(s): ['${commandStrings.join("', '")}']`;
  },
  running: (commandStrings) => {
    return `Running ${commandStrings.length} command(s): ['${commandStrings.join("', '")}']`;
  },
  errorOnMiddleCommand: (commandString, commandsLeft, skippedCommandStrings) => {
    const skippedCommandStringsLog = `'${skippedCommandStrings.join("', '")}'`;
    return `Error executing '${commandString}'. Stopping and skipping ${commandsLeft} command(s): [${skippedCommandStringsLog}]`;
  },
  boolSummary: () => {
    return `Bool condition supplied.`;
  },
  envVarSummary: (envVarName, envVarValue) => {
    let envVarValueLog;
    if (envVarValue === "") {
      envVarValueLog = `not set ("")`;
    } else if (envVarValue === undefined) {
      envVarValueLog = "not set";
    } else {
      envVarValueLog = `'${envVarValue}'`;
    }

    return `Environment variable '${envVarName}' is ${envVarValueLog}.`;
  },
  trueIfEmptyEnabled: () => {
    return `--true-if-empty is enabled.`;
  },
  forceEnabled: () => {
    return `--force is enabled.`;
  },
  conditionSummary: (condition) => {
    const clause = condition ? "_then_" : "_else_";
    return `Condition is '${condition}'. Running ${clause} command(s).`;
  },
};

main().catch((e) => {
  process.exit(e.code);
});
