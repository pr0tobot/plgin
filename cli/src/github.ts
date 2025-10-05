import { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import type { RegistryEntry } from './types.js';

export interface GitHubClientOptions {
  token: string;
  org: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private org: string;

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({ auth: options.token });
    this.org = options.org;
  }

  async getRegistryIndex(): Promise<RegistryEntry[]> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.org,
        repo: 'plgn-registry',
        path: 'registry.json'
      });

      if ('content' in data && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content) as RegistryEntry[];
      }

      return [];
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw new Error(`Failed to fetch registry index: ${error.message}`);
    }
  }

  async updateRegistryIndex(entries: RegistryEntry[], message: string): Promise<void> {
    const path = 'registry.json';
    const content = JSON.stringify(entries, null, 2);

    try {
      const { data: existingFile } = await this.octokit.repos.getContent({
        owner: this.org,
        repo: 'plgn-registry',
        path
      });

      if ('sha' in existingFile) {
        await this.octokit.repos.createOrUpdateFileContents({
          owner: this.org,
          repo: 'plgn-registry',
          path,
          message,
          content: Buffer.from(content).toString('base64'),
          sha: existingFile.sha
        });
      }
    } catch (error: any) {
      if (error.status === 404) {
        await this.octokit.repos.createOrUpdateFileContents({
          owner: this.org,
          repo: 'plgn-registry',
          path,
          message,
          content: Buffer.from(content).toString('base64')
        });
      } else {
        throw error;
      }
    }
  }

  async createRelease(name: string, version: string, tarballPath: string, checksum: string): Promise<string> {
    const tagName = `${name}@${version}`;

    const { data: release } = await this.octokit.repos.createRelease({
      owner: this.org,
      repo: 'plgn-registry',
      tag_name: tagName,
      name: `${name} v${version}`,
      body: `Pack release for ${name} v${version}\n\nChecksum (SHA256): \`${checksum}\``
    });

    return release.html_url;
  }

  async uploadReleaseAsset(releaseUrl: string, tarballBuffer: Buffer, filename: string): Promise<string> {
    const releaseId = parseInt(releaseUrl.split('/').pop() || '0');

    const { data: asset } = await this.octokit.repos.uploadReleaseAsset({
      owner: this.org,
      repo: 'plgn-registry',
      release_id: releaseId,
      name: filename,
      data: tarballBuffer as any
    });

    return asset.browser_download_url;
  }

  async ensureRegistryRepo(): Promise<void> {
    try {
      await this.octokit.repos.get({
        owner: this.org,
        repo: 'plgn-registry'
      });
    } catch (error: any) {
      if (error.status === 404) {
        await this.octokit.repos.createInOrg({
          org: this.org,
          name: 'plgn-registry',
          description: 'PLGN pack registry',
          auto_init: true,
          private: false
        });
      } else {
        throw error;
      }
    }
  }

  static computeChecksum(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }
}
