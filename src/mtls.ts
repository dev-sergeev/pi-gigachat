import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSecureContext } from "node:tls";
import type { MtlsMaterials } from "./connection-types.js";

export class GigaChatMtlsError extends Error {
	readonly code = "GIGACHAT_MTLS_ERROR";
}

function certificates(pem: string, label: string): X509Certificate[] {
	const blocks = pem.match(
		/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
	);
	if (
		!blocks?.length ||
		pem
			.replace(
				/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
				"",
			)
			.trim()
	)
		throw new GigaChatMtlsError(
			`GigaChat mTLS ${label}: expected PEM certificates.`,
		);
	try {
		return blocks.map((block) => new X509Certificate(block));
	} catch {
		throw new GigaChatMtlsError(
			`GigaChat mTLS ${label}: invalid PEM certificate.`,
		);
	}
}

export async function importMtlsMaterials(
	paths: {
		caPath: string;
		certPath: string;
		keyPath: string;
		passphrase?: string;
	},
	signal: AbortSignal,
): Promise<MtlsMaterials> {
	const read = async (path: string, label: string) => {
		signal.throwIfAborted();
		try {
			const expanded =
				path === "~"
					? homedir()
					: path.startsWith("~/")
						? resolve(homedir(), path.slice(2))
						: resolve(path);
			return await readFile(expanded, { encoding: "utf8", signal });
		} catch {
			signal.throwIfAborted();
			throw new GigaChatMtlsError(`GigaChat mTLS ${label}: cannot read file.`);
		}
	};
	const ca = await read(paths.caPath, "CA");
	certificates(ca, "CA");
	const cert = await read(paths.certPath, "client certificate");
	const chain = certificates(cert, "client certificate");
	const pem = await read(paths.keyPath, "private key");
	if (
		!/^\s*-----BEGIN (?:ENCRYPTED PRIVATE KEY|PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY)-----/.test(
			pem,
		)
	)
		throw new GigaChatMtlsError(
			"GigaChat mTLS private key: expected a PEM private key.",
		);
	let key: string;
	try {
		const privateKey = createPrivateKey({
			key: pem,
			format: "pem",
			passphrase: paths.passphrase,
		});
		if (!chain[0].checkPrivateKey(privateKey))
			throw new GigaChatMtlsError(
				"GigaChat mTLS private key does not match the client certificate.",
			);
		key = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
	} catch (error) {
		if (error instanceof GigaChatMtlsError) throw error;
		throw new GigaChatMtlsError(
			"GigaChat mTLS private key: invalid key or incorrect passphrase.",
		);
	}
	signal.throwIfAborted();
	try {
		createSecureContext({ ca, cert, key });
	} catch {
		throw new GigaChatMtlsError(
			"GigaChat mTLS materials are not suitable for TLS.",
		);
	}
	return { ca, cert, key };
}
