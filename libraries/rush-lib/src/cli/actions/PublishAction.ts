// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import colors from 'colors/safe';
import * as path from 'path';
import * as semver from 'semver';
import {
  CommandLineFlagParameter,
  CommandLineStringParameter,
  CommandLineChoiceParameter
} from '@rushstack/ts-command-line';
import { FileSystem } from '@rushstack/node-core-library';

import { IChangeInfo, ChangeType } from '../../api/ChangeManagement';
import { RushConfigurationProject } from '../../api/RushConfigurationProject';
import { Npm } from '../../utilities/Npm';
import { RushCommandLineParser } from '../RushCommandLineParser';
import { PublishUtilities } from '../../logic/PublishUtilities';
import { ChangelogGenerator } from '../../logic/ChangelogGenerator';
import { PrereleaseToken } from '../../logic/PrereleaseToken';
import { ChangeManager } from '../../logic/ChangeManager';
import { BaseRushAction } from './BaseRushAction';
import { PublishGit } from '../../logic/PublishGit';
import * as PolicyValidator from '../../logic/policy/PolicyValidator';
import { VersionPolicy } from '../../api/VersionPolicy';
import { DEFAULT_PACKAGE_UPDATE_MESSAGE } from './VersionAction';
import { Utilities } from '../../utilities/Utilities';
import { Git } from '../../logic/Git';

export class PublishAction extends BaseRushAction {
  private readonly _addCommitDetails: CommandLineFlagParameter;
  private readonly _apply: CommandLineFlagParameter;
  private readonly _includeAll: CommandLineFlagParameter;
  private readonly _npmAuthToken: CommandLineStringParameter;
  private readonly _npmTag: CommandLineStringParameter;
  private readonly _npmAccessLevel: CommandLineChoiceParameter;
  private readonly _publish: CommandLineFlagParameter;
  private readonly _regenerateChangelogs: CommandLineFlagParameter;
  private readonly _registryUrl: CommandLineStringParameter;
  private readonly _targetBranch: CommandLineStringParameter;
  private readonly _prereleaseName: CommandLineStringParameter;
  private readonly _partialPrerelease: CommandLineFlagParameter;
  private readonly _suffix: CommandLineStringParameter;
  private readonly _force: CommandLineFlagParameter;
  private readonly _versionPolicy: CommandLineStringParameter;
  private readonly _applyGitTagsOnPack: CommandLineFlagParameter;
  private readonly _commitId: CommandLineStringParameter;
  private readonly _releaseFolder: CommandLineStringParameter;
  private readonly _pack: CommandLineFlagParameter;
  private readonly _ignoreGitHooksParameter: CommandLineFlagParameter;

  private _prereleaseToken!: PrereleaseToken;
  private _hotfixTagOverride!: string;
  private _targetNpmrcPublishFolder!: string;
  private _targetNpmrcPublishPath!: string;

  public constructor(parser: RushCommandLineParser) {
    super({
      actionName: 'publish',
      summary: 'Reads and processes package publishing change requests generated by "rush change".',
      documentation:
        'Reads and processes package publishing change requests generated by "rush change". This will perform a ' +
        'read-only operation by default, printing operations executed to the console. To commit ' +
        'changes and publish packages, you must use the --commit flag and/or the --publish flag.',
      parser
    });

    this._apply = this.defineFlagParameter({
      parameterLongName: '--apply',
      parameterShortName: '-a',
      description: 'If this flag is specified, the change requests will be applied to package.json files.'
    });
    this._targetBranch = this.defineStringParameter({
      parameterLongName: '--target-branch',
      parameterShortName: '-b',
      argumentName: 'BRANCH',
      description:
        'If this flag is specified, applied changes and deleted change requests will be ' +
        'committed and merged into the target branch.'
    });
    this._publish = this.defineFlagParameter({
      parameterLongName: '--publish',
      parameterShortName: '-p',
      description: 'If this flag is specified, applied changes will be published to the NPM registry.'
    });
    this._addCommitDetails = this.defineFlagParameter({
      parameterLongName: '--add-commit-details',
      parameterShortName: undefined,
      description: 'Adds commit author and hash to the changelog.json files for each change.'
    });
    this._regenerateChangelogs = this.defineFlagParameter({
      parameterLongName: '--regenerate-changelogs',
      parameterShortName: undefined,
      description: 'Regenerates all changelog files based on the current JSON content.'
    });

    // NPM registry related parameters
    this._registryUrl = this.defineStringParameter({
      parameterLongName: '--registry',
      parameterShortName: '-r',
      argumentName: 'REGISTRY',
      description:
        `Publishes to a specified NPM registry. If this is specified, it will prevent the current commit will not be ` +
        'tagged.'
    });
    this._npmAuthToken = this.defineStringParameter({
      parameterLongName: '--npm-auth-token',
      parameterShortName: '-n',
      argumentName: 'TOKEN',
      description:
        '(DEPRECATED) Specifies the authentication token to use during publishing. This parameter is deprecated' +
        ' because command line parameters may be readable by unrelated processes on a lab machine. Instead, a' +
        ' safer practice is to pass the token via an environment variable and reference it from your ' +
        ' common/config/rush/.npmrc-publish file.'
    });
    this._npmTag = this.defineStringParameter({
      parameterLongName: '--tag',
      parameterShortName: '-t',
      argumentName: 'TAG',
      description:
        `The tag option to pass to npm publish. By default NPM will publish using the 'latest' tag, even if ` +
        `the package is older than the current latest, so in publishing workflows for older releases, providing ` +
        `a tag is important. When hotfix changes are made, this parameter defaults to 'hotfix'.`
    });
    this._npmAccessLevel = this.defineChoiceParameter({
      alternatives: ['public', 'restricted'],
      parameterLongName: '--set-access-level',
      parameterShortName: undefined,
      description:
        `By default, when Rush invokes "npm publish" it will publish scoped packages with an access level ` +
        `of "restricted". Scoped packages can be published with an access level of "public" by specifying ` +
        `that value for this flag with the initial publication. NPM always publishes unscoped packages with ` +
        `an access level of "public". For more information, see the NPM documentation for the "--access" ` +
        `option of "npm publish".`
    });

    // NPM pack tarball related parameters
    this._pack = this.defineFlagParameter({
      parameterLongName: '--pack',
      description:
        `Packs projects into tarballs instead of publishing to npm repository. It can only be used when ` +
        `--include-all is specified. If this flag is specified, NPM registry related parameters will be ignored.`
    });
    this._releaseFolder = this.defineStringParameter({
      parameterLongName: '--release-folder',
      argumentName: 'FOLDER',
      description:
        `This parameter is used with --pack parameter to provide customized location for the tarballs instead of ` +
        `the default value. `
    });
    // End of NPM pack tarball related parameters

    this._includeAll = this.defineFlagParameter({
      parameterLongName: '--include-all',
      parameterShortName: undefined,
      description:
        'If this flag is specified, all packages with shouldPublish=true in rush.json ' +
        'or with a specified version policy ' +
        'will be published if their version is newer than published version.'
    });
    this._versionPolicy = this.defineStringParameter({
      parameterLongName: '--version-policy',
      argumentName: 'POLICY',
      description:
        'Version policy name. Only projects with this version policy will be published if used ' +
        'with --include-all.'
    });
    this._prereleaseName = this.defineStringParameter({
      parameterLongName: '--prerelease-name',
      argumentName: 'NAME',
      description:
        'Bump up to a prerelease version with the provided prerelease name. Cannot be used with --suffix'
    });
    this._partialPrerelease = this.defineFlagParameter({
      parameterLongName: '--partial-prerelease',
      parameterShortName: undefined,
      description:
        'Used with --prerelease-name. Only bump packages to a prerelease version if they have changes.'
    });
    this._suffix = this.defineStringParameter({
      parameterLongName: '--suffix',
      argumentName: 'SUFFIX',
      description: 'Append a suffix to all changed versions. Cannot be used with --prerelease-name.'
    });
    this._force = this.defineFlagParameter({
      parameterLongName: '--force',
      parameterShortName: undefined,
      description: 'If this flag is specified with --publish, packages will be published with --force on npm'
    });
    this._applyGitTagsOnPack = this.defineFlagParameter({
      parameterLongName: '--apply-git-tags-on-pack',
      description:
        `If specified with --publish and --pack, git tags will be applied for packages` +
        ` as if a publish was being run without --pack.`
    });
    this._commitId = this.defineStringParameter({
      parameterLongName: '--commit',
      parameterShortName: '-c',
      argumentName: 'COMMIT_ID',
      description:
        `Used in conjunction with git tagging -- apply git tags at the commit hash` +
        ` specified. If not provided, the current HEAD will be tagged.`
    });
    this._ignoreGitHooksParameter = this.defineFlagParameter({
      parameterLongName: '--ignore-git-hooks',
      description: `Skips execution of all git hooks. Make sure you know what you are skipping.`
    });
  }

  /**
   * Executes the publish action, which will read change request files, apply changes to package.jsons,
   */
  protected async runAsync(): Promise<void> {
    await PolicyValidator.validatePolicyAsync(this.rushConfiguration, { bypassPolicy: false });

    // Example: "common\temp\publish-home"
    this._targetNpmrcPublishFolder = path.join(this.rushConfiguration.commonTempFolder, 'publish-home');

    // Example: "common\temp\publish-home\.npmrc"
    this._targetNpmrcPublishPath = path.join(this._targetNpmrcPublishFolder, '.npmrc');

    const allPackages: Map<string, RushConfigurationProject> = this.rushConfiguration.projectsByName;

    if (this._regenerateChangelogs.value) {
      console.log('Regenerating changelogs');
      ChangelogGenerator.regenerateChangelogs(allPackages, this.rushConfiguration);
      return;
    }

    this._validate();

    this._addNpmPublishHome();

    const git: Git = new Git(this.rushConfiguration);
    const publishGit: PublishGit = new PublishGit(git, this._targetBranch.value);
    if (this._includeAll.value) {
      this._publishAll(publishGit, allPackages);
    } else {
      this._prereleaseToken = new PrereleaseToken(
        this._prereleaseName.value,
        this._suffix.value,
        this._partialPrerelease.value
      );
      this._publishChanges(git, publishGit, allPackages);
    }

    console.log('\n' + colors.green('Rush publish finished successfully.'));
  }

  /**
   * Validate some input parameters
   */
  private _validate(): void {
    if (this._pack.value && !this._includeAll.value) {
      throw new Error('--pack can only be used with --include-all');
    }
    if (this._releaseFolder.value && !this._pack.value) {
      throw new Error(`--release-folder can only be used with --pack`);
    }
    if (this._applyGitTagsOnPack.value && !this._pack.value) {
      throw new Error(`${this._applyGitTagsOnPack.longName} must be used with ${this._pack.longName}`);
    }
  }

  private _publishChanges(
    git: Git,
    publishGit: PublishGit,
    allPackages: Map<string, RushConfigurationProject>
  ): void {
    const changeManager: ChangeManager = new ChangeManager(this.rushConfiguration);
    changeManager.load(
      this.rushConfiguration.changesFolder,
      this._prereleaseToken,
      this._addCommitDetails.value
    );

    if (changeManager.hasChanges()) {
      const orderedChanges: IChangeInfo[] = changeManager.packageChanges;
      const tempBranchName: string = `publish-${Date.now()}`;

      // Make changes in temp branch.
      publishGit.checkout(tempBranchName, true);

      this._setDependenciesBeforePublish();

      // Make changes to package.json and change logs.
      changeManager.apply(this._apply.value);
      changeManager.updateChangelog(this._apply.value);

      this._setDependenciesBeforeCommit();

      if (git.hasUncommittedChanges()) {
        // Stage, commit, and push the changes to remote temp branch.
        publishGit.addChanges(':/*');
        publishGit.commit(
          this.rushConfiguration.gitVersionBumpCommitMessage || DEFAULT_PACKAGE_UPDATE_MESSAGE,
          !this._ignoreGitHooksParameter.value
        );
        publishGit.push(tempBranchName, !this._ignoreGitHooksParameter.value);

        this._setDependenciesBeforePublish();

        // Override tag parameter if there is a hotfix change.
        for (const change of orderedChanges) {
          if (change.changeType === ChangeType.hotfix) {
            this._hotfixTagOverride = 'hotfix';
            break;
          }
        }

        // npm publish the things that need publishing.
        for (const change of orderedChanges) {
          if (change.changeType && change.changeType > ChangeType.dependency) {
            const project: RushConfigurationProject | undefined = allPackages.get(change.packageName);
            if (project) {
              if (!this._packageExists(project)) {
                this._npmPublish(change.packageName, project.publishFolder);
              } else {
                console.log(`Skip ${change.packageName}. Package exists.`);
              }
            } else {
              console.log(`Skip ${change.packageName}. Failed to find its project.`);
            }
          }
        }

        this._setDependenciesBeforeCommit();

        // Create and push appropriate Git tags.
        this._gitAddTags(publishGit, orderedChanges);
        publishGit.push(tempBranchName, !this._ignoreGitHooksParameter.value);

        // Now merge to target branch.
        publishGit.checkout(this._targetBranch.value!);
        publishGit.pull(!this._ignoreGitHooksParameter.value);
        publishGit.merge(tempBranchName, !this._ignoreGitHooksParameter.value);
        publishGit.push(this._targetBranch.value!, !this._ignoreGitHooksParameter.value);
        publishGit.deleteBranch(tempBranchName, true, !this._ignoreGitHooksParameter.value);
      } else {
        publishGit.checkout(this._targetBranch.value!);
        publishGit.deleteBranch(tempBranchName, false, !this._ignoreGitHooksParameter.value);
      }
    }
  }

  private _publishAll(git: PublishGit, allPackages: Map<string, RushConfigurationProject>): void {
    console.log(`Rush publish starts with includeAll and version policy ${this._versionPolicy.value}`);

    let updated: boolean = false;

    allPackages.forEach((packageConfig, packageName) => {
      if (
        packageConfig.shouldPublish &&
        (!this._versionPolicy.value || this._versionPolicy.value === packageConfig.versionPolicyName)
      ) {
        const applyTag: (apply: boolean) => void = (apply: boolean): void => {
          if (!apply) {
            return;
          }

          const packageVersion: string = packageConfig.packageJson.version;

          // Do not create a new tag if one already exists, this will result in a fatal error
          if (git.hasTag(packageConfig)) {
            console.log(
              `Not tagging ${packageName}@${packageVersion}. A tag already exists for this version.`
            );
            return;
          }

          git.addTag(
            !!this._publish.value,
            packageName,
            packageVersion,
            this._commitId.value,
            this._prereleaseName.value
          );
          updated = true;
        };

        if (this._pack.value) {
          // packs to tarball instead of publishing to NPM repository
          this._npmPack(packageName, packageConfig);
          applyTag(this._applyGitTagsOnPack.value);
        } else if (this._force.value || !this._packageExists(packageConfig)) {
          // Publish to npm repository
          this._npmPublish(packageName, packageConfig.publishFolder);
          applyTag(true);
        } else {
          console.log(`Skip ${packageName}. Not updated.`);
        }
      }
    });

    if (updated) {
      git.push(this._targetBranch.value!, !this._ignoreGitHooksParameter.value);
    }
  }

  private _gitAddTags(git: PublishGit, orderedChanges: IChangeInfo[]): void {
    for (const change of orderedChanges) {
      if (
        change.changeType &&
        change.changeType > ChangeType.dependency &&
        this.rushConfiguration.projectsByName.get(change.packageName)!.shouldPublish
      ) {
        git.addTag(
          !!this._publish.value && !this._registryUrl.value,
          change.packageName,
          change.newVersion!,
          this._commitId.value,
          this._prereleaseName.value
        );
      }
    }
  }

  private _npmPublish(packageName: string, packagePath: string): void {
    const env: { [key: string]: string | undefined } = PublishUtilities.getEnvArgs();
    const args: string[] = ['publish'];

    if (this.rushConfiguration.projectsByName.get(packageName)!.shouldPublish) {
      this._addSharedNpmConfig(env, args);

      if (this._npmTag.value) {
        args.push(`--tag`, this._npmTag.value);
      } else if (this._hotfixTagOverride) {
        args.push(`--tag`, this._hotfixTagOverride);
      }

      if (this._force.value) {
        args.push(`--force`);
      }

      if (this._npmAccessLevel.value) {
        args.push(`--access`, this._npmAccessLevel.value);
      }

      if (this.rushConfiguration.packageManager === 'pnpm') {
        // PNPM 4.11.0 introduced a feature that may interrupt publishing and prompt the user for input.
        // See this issue for details: https://github.com/microsoft/rushstack/issues/1940
        args.push('--no-git-checks');
      }

      // TODO: Yarn's "publish" command line is fairly different from NPM and PNPM.  The right thing to do here
      // would be to remap our options to the Yarn equivalents.  But until we get around to that, we'll simply invoke
      // whatever NPM binary happens to be installed in the global path.
      const packageManagerToolFilename: string =
        this.rushConfiguration.packageManager === 'yarn'
          ? 'npm'
          : this.rushConfiguration.packageManagerToolFilename;

      // If the auth token was specified via the command line, avoid printing it on the console
      const secretSubstring: string | undefined = this._npmAuthToken.value;

      PublishUtilities.execCommand(
        !!this._publish.value,
        packageManagerToolFilename,
        args,
        packagePath,
        env,
        secretSubstring
      );
    }
  }

  private _packageExists(packageConfig: RushConfigurationProject): boolean {
    const env: { [key: string]: string | undefined } = PublishUtilities.getEnvArgs();
    const args: string[] = [];
    this._addSharedNpmConfig(env, args);

    const publishedVersions: string[] = Npm.publishedVersions(
      packageConfig.packageName,
      packageConfig.publishFolder,
      env,
      args
    );

    const packageVersion: string = packageConfig.packageJsonEditor.version;

    // SemVer supports an obscure (and generally deprecated) feature where "build metadata" can be
    // appended to a version.  For example if our version is "1.2.3-beta.4+extra567", then "+extra567" is the
    // build metadata part.  The suffix has no effect on version comparisons and is mostly ignored by
    // the NPM registry.  Importantly, the queried version number will not include it, so we need to discard
    // it before comparing against the list of already published versions.
    const parsedVersion: semver.SemVer | null = semver.parse(packageVersion);
    if (!parsedVersion) {
      throw new Error(`The package "${packageConfig.packageName}" has an invalid "version" value`);
    }

    // For example, normalize "1.2.3-beta.4+extra567" -->"1.2.3-beta.4".
    //
    // This is redundant in the current API, but might change in the future:
    // https://github.com/npm/node-semver/issues/264
    parsedVersion.build = [];
    const normalizedVersion: string = parsedVersion.format();

    return publishedVersions.indexOf(normalizedVersion) >= 0;
  }

  private _npmPack(packageName: string, project: RushConfigurationProject): void {
    const args: string[] = ['pack'];
    const env: { [key: string]: string | undefined } = PublishUtilities.getEnvArgs();

    PublishUtilities.execCommand(
      !!this._publish.value,
      this.rushConfiguration.packageManagerToolFilename,
      args,
      project.publishFolder,
      env
    );

    if (this._publish.value) {
      // Copy the tarball the release folder
      const tarballName: string = this._calculateTarballName(project);
      const tarballPath: string = path.join(project.publishFolder, tarballName);
      const destFolder: string = this._releaseFolder.value
        ? this._releaseFolder.value
        : path.join(this.rushConfiguration.commonTempFolder, 'artifacts', 'packages');

      FileSystem.move({
        sourcePath: tarballPath,
        destinationPath: path.join(destFolder, tarballName),
        overwrite: true
      });
    }
  }

  private _calculateTarballName(project: RushConfigurationProject): string {
    // Same logic as how npm forms the tarball name
    const packageName: string = project.packageName;
    const name: string = packageName[0] === '@' ? packageName.substr(1).replace(/\//g, '-') : packageName;

    if (this.rushConfiguration.packageManager === 'yarn') {
      // yarn tarballs have a "v" before the version number
      return `${name}-v${project.packageJson.version}.tgz`;
    } else {
      return `${name}-${project.packageJson.version}.tgz`;
    }
  }

  private _setDependenciesBeforePublish(): void {
    for (const project of this.rushConfiguration.projects) {
      if (!this._versionPolicy.value || this._versionPolicy.value === project.versionPolicyName) {
        const versionPolicy: VersionPolicy | undefined = project.versionPolicy;

        if (versionPolicy) {
          versionPolicy.setDependenciesBeforePublish(project.packageName, this.rushConfiguration);
        }
      }
    }
  }

  private _setDependenciesBeforeCommit(): void {
    for (const project of this.rushConfiguration.projects) {
      if (!this._versionPolicy.value || this._versionPolicy.value === project.versionPolicyName) {
        const versionPolicy: VersionPolicy | undefined = project.versionPolicy;

        if (versionPolicy) {
          versionPolicy.setDependenciesBeforePublish(project.packageName, this.rushConfiguration);
        }
      }
    }
  }

  private _addNpmPublishHome(): void {
    // Create "common\temp\publish-home" folder, if it doesn't exist
    Utilities.createFolderWithRetry(this._targetNpmrcPublishFolder);

    // Copy down the committed "common\config\rush\.npmrc-publish" file, if there is one
    Utilities.syncNpmrc(this.rushConfiguration.commonRushConfigFolder, this._targetNpmrcPublishFolder, true);
  }

  private _addSharedNpmConfig(env: { [key: string]: string | undefined }, args: string[]): void {
    const userHomeEnvVariable: string = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    let registry: string = '//registry.npmjs.org/';

    // Check if .npmrc file exists in "common\temp\publish-home"
    if (FileSystem.exists(this._targetNpmrcPublishPath)) {
      // Redirect userHomeEnvVariable, NPM will use config in "common\temp\publish-home\.npmrc"
      env[userHomeEnvVariable] = this._targetNpmrcPublishFolder;
    }

    // Check if registryUrl and token are specified via command-line
    if (this._registryUrl.value) {
      const registryUrl: string = this._registryUrl.value;
      env['npm_config_registry'] = registryUrl; // eslint-disable-line dot-notation
      registry = registryUrl.substring(registryUrl.indexOf('//'));
    }

    if (this._npmAuthToken.value) {
      args.push(`--${registry}:_authToken=${this._npmAuthToken.value}`);
    }
  }
}
