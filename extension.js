// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
var vscode = require('vscode');
var commandExistsSync = require('command-exists').sync;
var upath = require("upath");
var moment = require("moment");
var isPathInside = require('is-path-inside');
var configLoader = require('./adapters/config-loader');

var outputChannel = null;
var fastOpenConnectionButton = null;
var fastOpenConnectionServerName = null;
var fastOpenConnectionProjectPath = null;
var servers = [];
var terminals = [];

// Shows a list of servers and returns a promise for what to do with the server
function selectServer() {
    if (!servers.length) {
        vscode.window.showInformationMessage("You don't have any servers");
        return;
    }

    // Show Command Palette with server list of servers
    // Return promise to allow for .then(...)
    return vscode.window.showQuickPick(servers.map(s => s.name), 'Select the server to connect...');
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
function activate(context) {

    initExtension();

    // Command palette 'Open SSH Connection'
    context.subscriptions.push(vscode.commands.registerCommand('sshextension.openConnection', function () {
        selectServer().then(s => openSSHConnection(s, false));
    }));

    // Command palette 'SSH Port Forwarding'
    context.subscriptions.push(vscode.commands.registerCommand('sshextension.portForwarding', function () {
        selectServer().then(s => createForwarding(s));
    }));

    // Launch reload configs if config files has been changed
    configLoader.startWatchers();
    configLoader.watcher.on('change', function(file) {
        loadServerList(loadServerConfigs());
    });
    vscode.workspace.onDidChangeConfiguration(function (event) {
        loadServerList(loadServerConfigs());
    });

    // If terminal closed 
    context.subscriptions.push(vscode.window.onDidCloseTerminal(function (event) {
        var terminal = terminals.find(function (element, index, array) {
            return element.terminal._id == this._id
        }, event);
        if (terminal === undefined) return;
        terminals.shift(terminal);
        outputChannel.appendLine("A terminal with a session for '" + terminal.host + "' has been killed.");
    }));
    // If the edited file is in the project directory
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(function (event) {
        manageFastOpenConnectionButtonState();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('sshextension.fastOpenConnection', function (c) {
        openSSHConnection(fastOpenConnectionServerName, true);
    }));

    var api = {
        connections(host = '', username = '') {
            return terminals.filter(function (element, index, array) {
                return (element.host == host || !host.length) && (element.username == username || !username.length)
            })
        }
    }
    return api;
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
}

// Loads an object that contains a list of servers in JSON format
function loadServerConfigs() {
    var result = true;
    var { merged_configs, messages } = configLoader.getConfigContents();
    messages.forEach(function(message){
        outputChannel.appendLine(message);
    });
    return { "result": result, "json": merged_configs };
}

// Function initializes an array of servers from a string or JSON object
function loadServerList(source) {
    var serversConfig = null;
    if (typeof (source) === "string") { // If the parameter is a string
        var parsedSource = JSON.parse(source);
        serversConfig = { "result": parsedSource !== undefined, "json": parsedSource };
    }
    else { // If the parameter is a JSON object
        serversConfig = source;
    }
    if (serversConfig.result) {
        servers = [];
        serversConfig.json.forEach(function (element) {
            var server = { "name": element.name, "configuration": element };
            servers.push(server);
        }, this);
    }
    else {
        outputChannel.appendLine("Unable to load server list, check configuration files.");
        return false;
    }
    return true;
}

// Function checks for ssh utilities
function checkSSHExecutable() {
    var checkResult = commandExistsSync('ssh');
    if (checkResult) {
        outputChannel.appendLine("Find ssh on your system.");
    } else {
        outputChannel.appendLine("Did not find ssh on your system.");
    }
    outputChannel.appendLine("If you use a third-party terminal, then make sure that there is an SSH utility.");
    return checkResult;
}

// This method creates a terminal for the server by its name
function openSSHConnection(serverName, isFastConnection, forwardingArgs = null) {
    if (serverName === undefined) return false;
    var server = servers.find(function (element, index, array) { return element.name == this }, serverName);
    var terminal = terminals.find(function (element, index, array) {
        return element.name == this.terminalName && element.isForwarding == this.isForwarding
    }, {"terminalName" : serverName, "isForwarding": (forwardingArgs != null)});
    var terminalIsNew = true;
    var hasErrors = false;
    if (terminal === undefined || (vscode.workspace.getConfiguration('sshextension').allowMultipleConnections && forwardingArgs == null)) { // If the terminal does not exist
        outputChannel.appendLine("New terminal session initialization for '" + server.configuration.host + "'...");
        if (server.configuration.host === undefined || server.configuration.username === undefined) {
            outputChannel.appendLine("Check host or username for '" + server.configuration.host + "'");
            hasErrors = true;
        }
        var sshCommand = 'ssh ' + ((forwardingArgs != null) ? forwardingArgs + " " : "") + server.configuration.host + ' -l ' + server.configuration.username;
        // Add port if different from default port
        if (server.configuration.port !== undefined && server.configuration.port && server.configuration.port !== 22)
            sshCommand += ' -p ' + server.configuration.port;
        var sshAuthorizationMethod = "byPass";
        // Authorization through an agent
        if (server.configuration.agent !== undefined && server.configuration.agent)
            sshAuthorizationMethod = "agent";
        // Authorization by private key
        if (server.configuration.privateKey !== undefined && server.configuration.privateKey) {
            sshCommand += ' -i "' + server.configuration.privateKey + '"';
            sshAuthorizationMethod = "byPrivateKey";
        }
        if (!hasErrors) {
            terminal = vscode.window.createTerminal(serverName + ((forwardingArgs != null) ? " (Forwarding)" : ""));
            // If custom commands defined send it to terminal
            terminals.push({ "name": serverName, "username": server.configuration.username, "host": server.configuration.host, "terminal": terminal, "isForwarding": (forwardingArgs != null) });
            if (server.configuration.portKnocking !== undefined && server.configuration.portKnocking.port !== undefined && server.configuration.portKnocking.port > 0) {
                var knockingHost = server.configuration.portKnocking.host !== undefined ? server.configuration.portKnocking.host : server.configuration.host;
                terminal.sendText("curl "+knockingHost+":"+server.configuration.portKnocking.port);
            }
            terminal.sendText(sshCommand);
            if (sshAuthorizationMethod == "byPass") {
                terminal.sendText(server.configuration.password);
            }
            if (vscode.workspace.getConfiguration('sshextension').openProjectCatalog) {
                if (isFastConnection)
                    terminal.sendText("cd " + fastOpenConnectionProjectPath);
                else if (server.configuration.path !== undefined) {
                    terminal.sendText("cd " + server.configuration.path);
                }
            }
            // If custom commands defined send it to terminal
            if (server.configuration.customCommands !== undefined && server.configuration.customCommands.length) {
                terminal.sendText(server.configuration.customCommands.join(' && '));
            }
            else if (vscode.workspace.getConfiguration('sshextension').customCommands.length) {
                terminal.sendText(vscode.workspace.getConfiguration('sshextension').customCommands.join(' && '));
            }
        }
    }
    else { // If the terminal instance was found
        terminal = terminal.terminal;
        terminalIsNew = false;
    }
    if (!hasErrors) {
        terminal.show();
        outputChannel.appendLine("A terminal with a session for '" + server.configuration.host + "' has been " + ((terminalIsNew) ? "created and displayed" : "displayed."));
    }
    else {
        outputChannel.appendLine("A terminal with a session for '" + server.configuration.host + "' has been not started, because errors were found.");
        vscode.window.showErrorMessage("Terminal has been not started, check output for more info.", "Check output").then(function(button){
            outputChannel.show();
        });
    }
    return hasErrors;
}

function createForwarding(serverName){
    function validateHostPort(port, domainReq = false){
        var portRegex = /^(?:(?:\S|[^:])+:{1})?(?:[0-5]?\d{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2]\d|6553[0-6]){1}$/;
        if (domainReq) portRegex = /^(?:(?:\S|[^:])+:{1}){1}(?:[0-5]?\d{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2]\d|6553[0-6]){1}$/;
        return (portRegex.test(port)) ? null : "Please enter a domain " + (!domainReq ? "(optional)  ": "") + "and port in range 0 - 65535 (e. g. localhost:9000" + (!domainReq ? " or 9000": "")+ ")";
    }
    function createForwardingArgs(option, firstAddress, secondAddress = null) {
        var forwardingArgs = option + " " + firstAddress;
        if (secondAddress != null)
            forwardingArgs += ":" + secondAddress;
        return forwardingArgs;
    }
    function toRecentlyUsed(recentlyUsedForwardings, forwardingArgs){
        if (recentlyUsedForwardings.indexOf(forwardingArgs) == -1) {
            vscode.window.showInformationMessage("Want to save this forwarding in recently used?", "Yes").then(function(button){
                if (button == "Yes"){
                    recentlyUsedForwardings.push(forwardingArgs);
                    vscode.workspace.getConfiguration("sshextension").update("recentlyUsedForwardings", recentlyUsedForwardings, true)
                }
            });
        }
    }
    var types = {
        'Local to remote': {
            'firstAdressPrompt': "Type local address/port (e. g. localhost:9000 or 9000)",
            'secondAddressPrompt': "Type remote address (e. g. localhost:9000)",
            "firstDomainReq": false,
            'secondDomainReq': true,
            "option": "-L"
        },
        'Remote to local': {
            'firstAdressPrompt': "Type remote address/port (e. g. localhost:9000 or 9000)",
            'secondAddressPrompt': "Type local address (e. g. localhost:9000)",
            "firstDomainReq": false,
            'secondDomainReq': true,
            "option": "-R"
        },
        'SOCKS': {
            'firstAdressPrompt': "Type address for SOCKS (e. g. localhost:9000)",
            "firstDomainReq": true,
            "option": "-D"
        }
    }
    var recentlyUsedForwardings = vscode.workspace.getConfiguration("sshextension").recentlyUsedForwardings;
    if (recentlyUsedForwardings.length) {
        types['Recently used'] = {};
    }
    // Show select of types
    vscode.window.showQuickPick(Object.keys(types), 'Select forwarding type...').then(function (type) {
        if (type === undefined) return;
        // Show input for first address
        if (type != "Recently used"){
            vscode.window.showInputBox({"validateInput": (s) => {
                return validateHostPort(s, types[type].firstDomainReq)
            },"prompt": types[type].firstAdressPrompt, "ignoreFocusOut" : true}).then(function (firstAddress) {
                if (firstAddress === undefined || !firstAddress.length) return;
                if (type != "SOCKS"){
                    // Show input for second address
                    vscode.window.showInputBox({"validateInput": (s) => {
                        return validateHostPort(s, types[type].secondDomainReq)
                    }, "prompt": types[type].secondAddressPrompt, "ignoreFocusOut" : true}).then(function (secondAddress) {
                        if (secondAddress === undefined || !secondAddress.length) return;
                        var forwardingArgs =  createForwardingArgs(types[type].option, firstAddress, secondAddress);
                        openSSHConnection(serverName, false, forwardingArgs);
                        toRecentlyUsed(recentlyUsedForwardings, forwardingArgs);
                    });
                }
                else {
                    var forwardingArgs = createForwardingArgs(types[type].option, firstAddress);
                    openSSHConnection(serverName, false, forwardingArgs);
                    toRecentlyUsed(recentlyUsedForwardings, forwardingArgs);
                }
            });
        }
        else {
            vscode.window.showQuickPick(recentlyUsedForwardings, 'Select forwarding arguments from recently used...').then(function (forwardingArgs) {
                if (forwardingArgs === undefined) return;
                openSSHConnection(serverName, false, forwardingArgs);
            });
        }
    });
}

// This method try to find server with project that contains file
function getProjectByFilePath(filePath) {
    var projectPath = null;
    // Get path to edited file with fixed drive letter case
    var openedFileName = upath.normalize(filePath);
    openedFileName = openedFileName.replace(/\w:/g, function (g) { return g.toLowerCase() })
    // Find the server that has the project containing this file
    var server = servers.find(function (element, index, array) {
        // If the server does not have any projects, go to the next
        if (element.configuration.project === undefined) return false;
        var thisServerMapped = false;
        Object.keys(element.configuration.project).forEach(function (item) {
            // Get project path with fixed drive letter case
            var serverProjectPath = upath.normalize(item);
            serverProjectPath = serverProjectPath.replace(/\w:/g, function (g) { return g.toLowerCase() });
            thisServerMapped = isPathInside(openedFileName, serverProjectPath);
            if (thisServerMapped) {
                projectPath = element.configuration.project[item];
            }
        }, this);
        return thisServerMapped;
    }, openedFileName);
    return { "server" : server, "projectPath" : projectPath };
}

function manageFastOpenConnectionButtonState() {
    var mappedServer = undefined;
    if (vscode.window.activeTextEditor != undefined) {
        var project = getProjectByFilePath(vscode.window.activeTextEditor.document.fileName);
        fastOpenConnectionProjectPath = project.projectPath;
        mappedServer = project.server;
    }
    // If the server is found then show the button and save the server name
    if (mappedServer !== undefined) {
        fastOpenConnectionButton.text = "$(terminal) Open SSH on " + mappedServer.configuration.name;
        fastOpenConnectionButton.show();
        fastOpenConnectionServerName = mappedServer.configuration.name;
    }
    // Otherwise hide the button
    else {
        fastOpenConnectionButton.hide();
    }
}

// Initialize extension
function initExtension() {
    outputChannel = vscode.window.createOutputChannel("ssh-extension");
    outputChannel.appendLine = (function(_super) {
        return function() {
            var now_formatted = moment().format("YYYY-MM-DD HH:mm:ss");
            arguments[0] = "[" + now_formatted + "] " + arguments[0];
            return _super.apply(this, arguments);
        };
    })(outputChannel.appendLine);
    checkSSHExecutable();
    loadServerList(loadServerConfigs());
    fastOpenConnectionButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    fastOpenConnectionButton.command = "sshextension.fastOpenConnection";
    manageFastOpenConnectionButtonState();
    return true;
}

exports.deactivate = deactivate;
