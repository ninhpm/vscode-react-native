// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as Q from "q";
import * as vscode from "vscode";

import {MessagingHelper}from "../common/extensionMessaging";
import {OutputChannelLogger} from "./log/OutputChannelLogger";
import {Packager} from "../common/packager";
import {PackagerStatusIndicator} from "./packagerStatusIndicator";
import {LogCatMonitor} from "./android/logCatMonitor";
import {FileSystem} from "../common/node/fileSystem";
import {SettingsHelper} from "./settingsHelper";
import {Telemetry} from "../common/telemetry";
import {PlatformResolver} from "./platformResolver";
import {TelemetryHelper} from "../common/telemetryHelper";
import {TargetPlatformHelper} from "../common/targetPlatformHelper";
import {MobilePlatformDeps} from "./generalMobilePlatform";
import {IRemoteExtension} from "../common/remoteExtension";
import * as rpc from "noice-json-rpc";
import * as WebSocket from "ws";
import WebSocketServer = WebSocket.Server;

export class ExtensionServer implements vscode.Disposable {
    public api: IRemoteExtension;
    private serverInstance: WebSocketServer | null;
    private reactNativePackager: Packager;
    private reactNativePackageStatusIndicator: PackagerStatusIndicator;
    private pipePath: string;
    private logCatMonitor: LogCatMonitor | null = null;
    private logger: OutputChannelLogger = OutputChannelLogger.getMainChannel();

    public constructor(projectRootPath: string, reactNativePackager: Packager, packagerStatusIndicator: PackagerStatusIndicator) {
        this.pipePath = MessagingHelper.getPath(projectRootPath);
        this.reactNativePackager = reactNativePackager;
        this.reactNativePackageStatusIndicator = packagerStatusIndicator;
    }

    /**
     * Starts the server.
     */
    public setup(): Q.Promise<void> {

        let deferred = Q.defer<void>();

        let launchCallback = (error: any) => {
            this.logger.debug(`Extension messaging server started at ${this.pipePath}.`);
            deferred.resolve(void 0);
        };

        this.serverInstance = new WebSocketServer({port: <any>this.pipePath});
        this.api = new rpc.Server(this.serverInstance).api();
        this.serverInstance.on("open", launchCallback.bind(this));
        this.serverInstance.on("error", this.recoverServer.bind(this));

        this.setupApiHandlers();

        return deferred.promise;
    }

    /**
     * Stops the server.
     */
    public dispose(): void {
        if (this.serverInstance) {
            this.serverInstance.close();
            this.serverInstance = null;
        }

        this.stopMonitoringLogCat();
    }

    private setupApiHandlers(): void {
        let methods: any = {};
        methods.stopMonitoringLogCat = this.stopMonitoringLogCat.bind(this);
        methods.getPackagerPort = this.getPackagerPort.bind(this);
        methods.sendTelemetry = this.sendTelemetry.bind(this);
        methods.openFileAtLocation = this.openFileAtLocation.bind(this);
        methods.showInformationMessage = this.showInformationMessage.bind(this);
        methods.launch = this.launch.bind(this);
        methods.showDevMenu = this.showDevMenu.bind(this);
        methods.reloadApp = this.reloadApp.bind(this);

        this.api.Extension.expose(methods);
    }

    private showDevMenu(deviceId?: string) {
        this.api.Debugger.emitShowDevMenu(deviceId);
    }

    private reloadApp(deviceId?: string) {
        this.api.Debugger.emitReloadApp(deviceId);
    }

    /**
     * Recovers the server in case the named socket we use already exists, but no other instance of VSCode is active.
     */
    private recoverServer(error: any): void {
        let errorHandler = (e: any) => {
            /* The named socket is not used. */
            if (e.code === "ECONNREFUSED") {
                new FileSystem().removePathRecursivelyAsync(this.pipePath)
                    .then(() => {
                        return this.setup();
                    })
                    .done();
            }
        };

        /* The named socket already exists. */
        if (error.code === "EADDRINUSE") {
            let clientSocket = new WebSocket(`ws+unix://${this.pipePath}`);
            clientSocket.on("error", errorHandler);
            clientSocket.on("open", function() {
                clientSocket.close();
            });
        }
    }

    /**
     * Message handler for GET_PACKAGER_PORT.
     */
    private getPackagerPort(): number {
        return SettingsHelper.getPackagerPort();
    }

    /**
     * Message handler for OPEN_FILE_AT_LOCATION
     */
    private openFileAtLocation(filename: string, lineNumber: number): Promise<void> {
        return new Promise((resolve) => {
            vscode.workspace.openTextDocument(vscode.Uri.file(filename))
                .then((document: vscode.TextDocument) => {
                    vscode.window.showTextDocument(document)
                        .then((editor: vscode.TextEditor) => {
                            let range = editor.document.lineAt(lineNumber - 1).range;
                            editor.selection = new vscode.Selection(range.start, range.end);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                            resolve();
                        });
                });
        });
    }

    private stopMonitoringLogCat(): void {
        if (this.logCatMonitor) {
            this.logCatMonitor.dispose();
            this.logCatMonitor = null;
        }
    }

    /**
     * Sends telemetry
     */
    private sendTelemetry(extensionId: string, extensionVersion: string, appInsightsKey: string, eventName: string, properties: {[key: string]: string}, measures: {[key: string]: number}): void {
        Telemetry.sendExtensionTelemetry(extensionId, extensionVersion, appInsightsKey, eventName, properties, measures);
    }

    /**
     * Message handler for SHOW_INFORMATION_MESSAGE
     */
    private showInformationMessage(message: string): void {
        vscode.window.showInformationMessage(message);
    }

    private launch(request: any): Promise<any> {
        let mobilePlatformOptions = requestSetup(request.arguments);

        // We add the parameter if it's defined (adapter crashes otherwise)
        if (!isNullOrUndefined(request.arguments.logCatArguments)) {
            mobilePlatformOptions.logCatArguments = [parseLogCatArguments(request.arguments.logCatArguments)];
        }

        if (!isNullOrUndefined(request.arguments.variant)) {
            mobilePlatformOptions.variant = request.arguments.variant;
        }

        if (!isNullOrUndefined(request.arguments.scheme)) {
            mobilePlatformOptions.scheme = request.arguments.scheme;
        }

        mobilePlatformOptions.packagerPort = SettingsHelper.getPackagerPort();
        const platformDeps: MobilePlatformDeps = {
            packager: this.reactNativePackager,
            packageStatusIndicator: this.reactNativePackageStatusIndicator,
        };
        const mobilePlatform = new PlatformResolver()
            .resolveMobilePlatform(request.arguments.platform, mobilePlatformOptions, platformDeps);
        return new Promise((resolve, reject) => {
            TelemetryHelper.generate("launch", (generator) => {
                generator.step("checkPlatformCompatibility");
                TargetPlatformHelper.checkTargetPlatformSupport(mobilePlatformOptions.platform);
                generator.step("startPackager");
                return mobilePlatform.startPackager()
                    .then(() => {
                        // We've seen that if we don't prewarm the bundle cache, the app fails on the first attempt to connect to the debugger logic
                        // and the user needs to Reload JS manually. We prewarm it to prevent that issue
                        generator.step("prewarmBundleCache");
                        this.logger.info("Prewarming bundle cache. This may take a while ...");
                        return mobilePlatform.prewarmBundleCache();
                    })
                    .then(() => {
                        generator.step("mobilePlatform.runApp");
                        this.logger.info("Building and running application.");
                        return mobilePlatform.runApp();
                    })
                    .then(() => {
                        generator.step("mobilePlatform.enableJSDebuggingMode");
                        return mobilePlatform.enableJSDebuggingMode();
                    })
                    .then(() => {
                        resolve();
                    })
                    .catch(error => {
                        this.logger.error(error);
                        reject(error);
                    });
            });
        });
    }
}

/**
 * Parses log cat arguments to a string
 */
function parseLogCatArguments(userProvidedLogCatArguments: any): string {
    return Array.isArray(userProvidedLogCatArguments)
        ? userProvidedLogCatArguments.join(" ") // If it's an array, we join the arguments
        : userProvidedLogCatArguments; // If not, we leave it as-is
}

function isNullOrUndefined(value: any): boolean {
    return typeof value === "undefined" || value === null;
}

function requestSetup(args: any): any {
    const projectRootPath = getProjectRoot(args);
    let mobilePlatformOptions: any = {
        projectRoot: projectRootPath,
        platform: args.platform,
        target: args.target || "simulator",
    };

    if (!args.runArguments) {
        let runArgs = SettingsHelper.getRunArgs(args.platform, args.target || "simulator");
        mobilePlatformOptions.runArguments = runArgs;
    }

    return mobilePlatformOptions;
}

function getProjectRoot(args: any): string {
    return SettingsHelper.getReactNativeProjectRoot();
}
