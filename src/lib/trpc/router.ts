import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hash } from '../hash';
import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';
import { initTRPC, type inferAsyncReturnType } from '@trpc/server';
import { z } from 'zod';
import { marked } from 'marked';
import prisma from '$lib/trpc/db';
import {
	Prisma,
	Role,
	Status,
	type Announcement,
	type Settings,
	type User,
	type Event,
} from '@prisma/client';
import type { Cookies } from '@sveltejs/kit';
import SuperJSON from 'superjson';

export function createContext(cookies: Cookies) {
	return { magicLink: cookies.get('magicLink') ?? '' };
}
type Context = inferAsyncReturnType<typeof createContext>;
export const t = initTRPC.context<Context>().create({ transformer: SuperJSON });

const MAGIC_LINK_LENGTH = 32;
const CHARSET = 'abcdefghijklmnopqrstuvwxyz';
const FILE_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MB

sgMail.setApiKey(process.env.SENDGRID_KEY as string);
const transporter = nodemailer.createTransport({
	host: process.env.EMAIL_HOST,
	port: Number(process.env.EMAIL_PORT),
	secure: true,
	auth: {
		user: process.env.EMAIL_USER,
		pass: process.env.EMAIL_PASS,
	},
});

const client = new S3Client({ region: 'us-east-1' });

const userSchema = z
	.object({
		fullName: z.string().optional(),
		preferredName: z.string().optional(),
		gender: z.string().optional(),
		race: z.array(z.string()).optional(),
		pronouns: z.string().optional(),
		photoReleaseAgreed: z.boolean().optional(),
		liabilityWaiverAgreed: z.boolean().optional(),
		codeOfConductAgreed: z.boolean().optional(),
		major: z.string().optional(),
		classification: z.string().optional(),
		graduation: z.string().optional(),
		firstGeneration: z.boolean().optional(),
		international: z.boolean().optional(),
		hackathonsAttended: z.number().optional(),
		workshops: z.array(z.string()).optional(),
		referrer: z.string().optional(),
		excitedAbout: z.string().optional(),
		resume: z.any(),
		github: z.string().optional(),
		linkedin: z.string().optional(),
		website: z.string().optional(),
		lunch: z.boolean().optional(),
		dietaryRestrictions: z.array(z.string()).optional(),
		allergies: z.string().optional(),
		accommodations: z.string().optional(),
		other: z.string().optional(),
	})
	.strict();
const settingsSchema = z
	.object({
		applicationOpen: z.boolean().optional(),
		confirmBy: z.date().nullable().optional(),
		info: z.string().optional(),
		rollingAdmissions: z.boolean().optional(),
		acceptanceTemplate: z.string().optional(),
	})
	.strict();

const getSettings = async (): Promise<Settings> => {
	return await prisma.settings.findUniqueOrThrow({ where: { id: 0 } });
};

const sendEmail = async (
	recipient: string,
	subject: string,
	message: string,
	name: string | null
): Promise<string> => {
	// Preface with warning if not in production
	let warning = '';
	message = marked.parse(message);
	if (process.env.VERCEL_ENV !== 'production') {
		// Only allow emails to YOPmail on staging
		if (process.env.VERCEL_ENV === 'preview' && !recipient.endsWith('@yopmail.com')) {
			return 'Only @yopmail.com addresses are allowed on staging.';
		}
		warning = `<h1>
			WARNING: This email was sent from a testing environment.
			Be careful when opening any links or attachments!
			This message cannot be guaranteed to come from Freetail Hackers.
			</h1>`;
	}
	const greeting = name ? `Hi ${name},` : 'Hi,';

	const email = {
		to: recipient,
		from: 'hello@freetailhackers.com',
		subject: subject,
		html: `
			${warning}
			${greeting}
			${message}
			If you have any questions, you may email us at <a href="mailto:tech@freetailhackers.com">tech@freetailhackers.com</a>.
			<br>
			<br>
			Best,
			<br>
			Freetail Hackers`,
	};
	try {
		if (process.env.SENDGRID_KEY) {
			await sgMail.send(email);
		} else {
			await transporter.sendMail(email);
		}
		return 'We sent an email to ' + recipient + '!';
	} catch (error) {
		console.error(error);
		console.error(`To: ${recipient}, Subject: ${subject}, Message: ${message}`);
		return 'There was an error sending the email. Please try again later.';
	}
};

export const router = t.router({
	/**
	 * Gets the logged in user, or a user by their *HASHED* magic link.
	 */
	getUser: t.procedure.input(z.string().optional()).query(async (req): Promise<User | null> => {
		return await prisma.user.findUnique({
			where: {
				magicLink: req.input ?? (await hash(req.ctx.magicLink)),
			},
		});
	}),

	/**
	 * Sets the logged in user to the given data. If the user has finished
	 * their application, they will be un-applied.
	 */
	setUser: t.procedure.input(userSchema).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: { magicLink: await hash(req.ctx.magicLink) },
		});
		if (!(await getSettings()).applicationOpen) {
			throw new Error('Sorry, applications are closed.');
		}
		// Upload resume to S3
		if (
			req.input.resume instanceof Blob &&
			req.input.resume.size > 0 &&
			req.input.resume.size < FILE_SIZE_LIMIT
		) {
			await client.send(
				new PutObjectCommand({
					Bucket: process.env.S3_BUCKET,
					Key: `${user.id}/${req.input.resume.name}`,
					Body: Buffer.from(await req.input.resume.arrayBuffer()),
				})
			);
			req.input.resume = `https://s3.amazonaws.com/${process.env.S3_BUCKET}/${user.id}/${req.input.resume.name}`;
		} else {
			req.input.resume = undefined;
		}
		// Only let verified users that haven't received a decision update their info
		if (user.status === Status.VERIFIED || user.status === Status.APPLIED) {
			await prisma.user.update({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
				// "Un-apply" the user if they're already applied
				data: { ...req.input, status: Status.VERIFIED },
			});
		}
		// Remove user from pending decision pool
		await prisma.decision.deleteMany({
			where: {
				userId: user.id,
			},
		});
	}),

	/**
	 * Attempts to submit the user's application. Returns a dictionary
	 * containing questions with validation errors, if any.
	 */
	submitApplication: t.procedure.mutation(async (req): Promise<Record<string, string>> => {
		// Ensure applications are open and the user has not received a decision yet
		const user = await prisma.user.findUniqueOrThrow({
			where: { magicLink: await hash(req.ctx.magicLink) },
		});
		if (!(await getSettings()).applicationOpen) {
			throw new Error('Sorry, applications are closed.');
		}
		if (user.status !== Status.VERIFIED) {
			throw new Error('You have already submitted your application.');
		}

		// Validate the user's data
		const errors: Record<string, string> = {};
		if (user.fullName === null || user.fullName.trim() === '') {
			errors.name = 'Please enter your full name.';
		}
		if (user.preferredName === null || user.preferredName.trim() === '') {
			errors.name = 'Please enter your preferred name.';
		}
		if (user.gender === null) {
			errors.gender = 'Please specify your gender.';
		}
		if (!user.photoReleaseAgreed) {
			errors.photoReleaseAgreed = 'You must agree to the photo release to participate.';
		}
		if (!user.liabilityWaiverAgreed) {
			errors.liabilityWaiverAgreed = 'You must agree to the liability waiver to participate.';
		}
		if (!user.codeOfConductAgreed) {
			errors.codeOfConductAgreed = 'You must agree to the code of conduct to participate.';
		}
		if (user.major === null || user.major.trim() === '') {
			errors.major = 'Please provide your major.';
		}
		if (user.classification === null) {
			errors.classification = 'Please specify your classification.';
		}
		if (user.graduation === null) {
			errors.graduationYear = 'Please specify your graduation year.';
		}
		if (user.hackathonsAttended === null) {
			errors.hackathonsAttended = 'Please specify the number of hackathons you have attended.';
		}
		if (user.referrer === null) {
			errors.referrer = 'Please specify how you heard about HackTX.';
		}
		if (user.excitedAbout === null || user.excitedAbout.trim() === '') {
			errors.excitedAbout = 'Please tell us what you are excited about.';
		}
		try {
			if (user.website !== null && user.website.trim() !== '') {
				new URL(user.website);
			}
		} catch (e) {
			errors.website = 'Please enter a valid URL.';
		}
		if (user.dietaryRestrictions === null) {
			errors.dietaryRestrictions = 'Please specify your dietary restrictions.';
		}
		// Update status to applied if there are no errors
		if (Object.keys(errors).length == 0) {
			await prisma.user.update({
				where: { magicLink: await hash(req.ctx.magicLink) },
				data: { status: Status.APPLIED },
			});
		}
		return errors;
	}),

	/**
	 * Confirms or declines the logged in user's acceptance.
	 */
	rsvpUser: t.procedure
		.input(z.enum(['CONFIRMED', 'DECLINED']))
		.mutation(async (req): Promise<void> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: { magicLink: await hash(req.ctx.magicLink) },
			});
			const deadline = (await getSettings()).confirmBy;
			if (req.input === 'CONFIRMED') {
				// Hackers should only be able to confirm before deadline
				if (user.status === Status.ACCEPTED && (deadline === null || new Date() < deadline)) {
					await prisma.user.update({
						where: { magicLink: await hash(req.ctx.magicLink) },
						data: { status: Status.CONFIRMED },
					});
				}
			} else {
				// Hackers should be able to decline after accepting and/or the deadline
				if (user.status === Status.ACCEPTED || user.status === Status.CONFIRMED) {
					await prisma.user.update({
						where: { magicLink: await hash(req.ctx.magicLink) },
						data: { status: Status.DECLINED },
					});
				}
			}
		}),

	/**
	 * Creates a new user with the given email, or generates a new magic
	 * link if they already exist. Returns the success status as a
	 * string.
	 */
	loginWithEmail: t.procedure.input(z.string()).mutation(async (req): Promise<string> => {
		const email = req.input.trim().toLowerCase();

		if (!email.match(/^\S+utexas.edu$/)) {
			return 'Please use your utexas.edu email address.';
		}

		// Generate a magic link
		const chars = new Uint8Array(MAGIC_LINK_LENGTH);
		crypto.getRandomValues(chars);
		const magicLink = Array.from(chars)
			.map((n) => CHARSET[n % CHARSET.length])
			.join('');

		// Create user and email magic link only if not already registered with this email
		await prisma.user.upsert({
			where: { email },
			create: {
				email: email,
				magicLink: await hash(magicLink),
			},
			update: {
				magicLink: await hash(magicLink),
			},
		});

		// Send email with magic link
		const link = `${process.env.DOMAIN_NAME}/login/${magicLink}`;
		const message = `Please click on this link to log in to Rodeo: <a href="${link}">${link}</a>
			<br>
			<br>
			Keep this email safe as anyone with this link can log in to your account.
			If you misplace this email, you can always request a new link by registering again with this same email address.
			Note that this will invalidate your previous link.`;
		return await sendEmail(email, 'Welcome to Rodeo!', message, null);
	}),

	/**
	 * Creates a new user with the given email. Logged-in user must be an admin.
	 */
	createUser: t.procedure
		.input(
			z.object({
				fullName: z.string(),
				email: z
					.string()
					.trim()
					.transform((email) => email.toLowerCase()),
				role: z.nativeEnum(Role),
			})
		)
		.mutation(async (req): Promise<string> => {
			// Generate a magic link
			const chars = new Uint8Array(MAGIC_LINK_LENGTH);
			crypto.getRandomValues(chars);
			const magicLink = Array.from(chars)
				.map((n) => CHARSET[n % CHARSET.length])
				.join('');

			// Create user and email magic link
			try {
				await prisma.user.create({
					data: { magicLink: await hash(magicLink), ...req.input },
				});
			} catch (e) {
				if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
					return 'User with this email already exists.';
				}
			}

			// Send email with magic link
			const link = `${process.env.DOMAIN_NAME}/login/${magicLink}`;
			const message = `Please click on this link to log in to Rodeo: <a href="${link}">${link}</a>
			<br>
			<br>
			Keep this email safe as anyone with this link can log in to your account.
			If you misplace this email, you can always request a new link by registering again with this same email address.
			Note that this will invalidate your previous link.`;
			return await sendEmail(req.input.email, 'Welcome to Rodeo!', message, null);
		}),

	/**
	 * Verify a user.
	 */
	verifyUser: t.procedure.mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUnique({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user !== null && user.status === Status.CREATED) {
			await prisma.user.update({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
				data: {
					status: Status.VERIFIED,
				},
			});
		}
	}),

	/**
	 * Scan a user's Hacker ID for the given action. Logged-in user must
	 * be an organizer or admin.
	 */
	scanUser: t.procedure
		.input(z.object({ magicLink: z.string(), action: z.string() }))
		.mutation(async (req): Promise<void> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ORGANIZER && user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}
			const scanCount = (
				await prisma.user.findUniqueOrThrow({
					where: {
						magicLink: req.input.magicLink,
					},
				})
			).scanCount as Prisma.JsonObject;
			const scans = Number(scanCount[req.input.action] ?? 0);
			await prisma.user.update({
				where: {
					magicLink: req.input.magicLink,
				},
				data: {
					scanCount: { ...scanCount, [req.input.action]: scans + 1 },
				},
			});
		}),

	/**
	 * Returns the number of hackers who have scanned for the given
	 * action at least once. Logged-in user must be an organizer or
	 * admin.
	 */
	getScanCount: t.procedure.input(z.string()).query(async (req): Promise<number> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ORGANIZER && user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		return await prisma.user.count({
			where: {
				AND: [
					{
						role: Role.HACKER,
					},
					{
						scanCount: {
							path: [req.input],
							gt: 0,
						},
					},
				],
			},
		});
	}),

	/**
	 * Bulk accepts, rejects, or waitlists a list of IDs of users with
	 * submitted applications. User must be an admin.
	 */
	decideUsers: t.procedure
		.input(
			z.object({
				decision: z.enum(['ACCEPTED', 'REJECTED', 'WAITLISTED']),
				ids: z.array(z.number()),
			})
		)
		.mutation(async (req): Promise<void> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}
			for (const id of req.input.ids) {
				const user = await prisma.user.findUniqueOrThrow({
					where: {
						id: id,
					},
				});
				if (user.status === Status.APPLIED || user.status === Status.WAITLISTED) {
					await prisma.decision.upsert({
						where: {
							userId: id,
						},
						create: {
							userId: id,
							status: req.input.decision,
						},
						update: {
							status: req.input.decision,
						},
					});
				}
			}
		}),

	/**
	 * Confirms walk-in users who have applied. Logged-in user must be an admin.
	 */
	confirmWalkIns: t.procedure.input(z.array(z.number())).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		for (const id of req.input) {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					id: id,
				},
			});
			// NOTE: This if statement is a good argument for why each status should be a boolean
			// Then we could just check if the user has applied at some point
			if (user.status !== Status.CREATED && user.status !== Status.VERIFIED) {
				// Use deleteMany to avoid not found errors
				await prisma.decision.deleteMany({
					where: {
						userId: id,
					},
				});
				await prisma.user.update({
					where: {
						id: id,
					},
					data: {
						status: Status.CONFIRMED,
					},
				});
			}
		}
	}),

	/**
	 * Gets all decisions. User must be an admin.
	 */
	getDecisions: t.procedure.query(
		async (
			req
		): Promise<{
			accepted: Prisma.DecisionGetPayload<{ include: { user: true } }>[];
			rejected: Prisma.DecisionGetPayload<{ include: { user: true } }>[];
			waitlisted: Prisma.DecisionGetPayload<{ include: { user: true } }>[];
		}> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}
			return {
				accepted: await prisma.decision.findMany({
					where: { status: Status.ACCEPTED },
					include: { user: true },
				}),
				rejected: await prisma.decision.findMany({
					where: { status: Status.REJECTED },
					include: { user: true },
				}),
				waitlisted: await prisma.decision.findMany({
					where: { status: Status.WAITLISTED },
					include: { user: true },
				}),
			};
		}
	),

	/**
	 * Releases all decisions. User must be an admin. This will empty
	 * the decisions table, apply all pending decisions to the users
	 * table, and send out email notifications.
	 */
	releaseAllDecisions: t.procedure.mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		const decisions = await prisma.decision.findMany();
		for (const decision of decisions) {
			const updateStatus = prisma.user.update({
				where: {
					id: decision.userId,
					status: { in: [Status.APPLIED, Status.WAITLISTED] },
				},
				data: {
					status: decision.status,
				},
			});
			const deleteDecision = prisma.decision.delete({
				where: {
					id: decision.id,
				},
			});

			const recipient = await prisma.user.findUniqueOrThrow({
				where: {
					id: decision.userId,
				},
			});

			// preconfigured templates, this structure will change later but is a proof of concept
			const subject = 'Freetail Hackers Status Update';

			await prisma.$transaction([updateStatus, deleteDecision]);

			await sendEmail(
				recipient.email,
				subject,
				(
					await getSettings()
				).acceptanceTemplate,
				recipient.preferredName
			);
		}
	}),

	/**
	 * Bulk releases a list of pending decisions by user ID. User must
	 * be an admin. This will send out email notifications.
	 */
	releaseDecisions: t.procedure.input(z.array(z.number())).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		for (const id of req.input) {
			const decision = await prisma.decision.findUniqueOrThrow({
				where: {
					userId: id,
				},
			});
			const updateStatus = prisma.user.update({
				where: {
					id: decision.userId,
					status: { in: [Status.APPLIED, Status.WAITLISTED] },
				},
				data: {
					status: decision.status,
				},
			});
			const deleteDecision = prisma.decision.delete({
				where: {
					id: decision.id,
				},
			});

			const recipient = await prisma.user.findUniqueOrThrow({
				where: {
					id: id,
				},
			});

			// preconfigured templates, this structure will change later but is a proof of concept
			const subject = 'Freetail Hackers Status Update';

			await prisma.$transaction([updateStatus, deleteDecision]);

			await sendEmail(
				recipient.email,
				subject,
				(
					await getSettings()
				).acceptanceTemplate,
				recipient.preferredName
			);
		}
	}),

	/**
	 * Bulk removes a list of pending decisions by user ID. User must be
	 * an admin.
	 */
	removeDecisions: t.procedure.input(z.array(z.number())).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		await prisma.decision.deleteMany({
			where: {
				userId: { in: req.input },
			},
		});
	}),

	/**
	 * Gets all users. User must be an admin.
	 */
	getUsers: t.procedure.query(
		async (req): Promise<Prisma.UserGetPayload<{ include: { decision: true } }>[]> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}
			return await prisma.user.findMany({ orderBy: [{ id: 'asc' }], include: { decision: true } });
		}
	),

	/**
	 * Gets one user that has submitted their application. User must be an admin.
	 */
	getAppliedUser: t.procedure.query(
		async (req): Promise<Prisma.UserGetPayload<{ include: { decision: true } }> | null> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}
			return await prisma.user.findFirst({
				where: {
					status: { in: [Status.APPLIED, Status.WAITLISTED] },
					decision: null,
				},
				include: { decision: true },
			});
		}
	),

	/**
	 * Gets all announcements.
	 */
	getAnnouncements: t.procedure.query(async (): Promise<Announcement[]> => {
		return await prisma.announcement.findMany({
			orderBy: [{ published: 'desc' }],
		});
	}),

	/**
	 * Creates a new announcement. User must be an admin.
	 */
	createAnnouncement: t.procedure.input(z.string().min(1)).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		await prisma.announcement.create({ data: { body: req.input } });
	}),

	/**
	 * Deletes an announcement by ID. User must be an admin.
	 */
	deleteAnnouncement: t.procedure.input(z.number()).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		await prisma.announcement.delete({ where: { id: req.input } });
	}),

	/**
	 * Returns public settings.
	 */
	getPublicSettings: t.procedure.query(
		async (): Promise<{ applicationOpen: boolean; confirmBy: Date | null; info: string }> => {
			const settings = await getSettings();
			return {
				applicationOpen: settings.applicationOpen,
				confirmBy: settings.confirmBy,
				info: settings.info,
			};
		}
	),

	/**
	 * Get all settings. User must be an admin.
	 */
	getAllSettings: t.procedure.query(async (req): Promise<Settings> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		return await getSettings();
	}),

	/**
	 * Sets the given settings to the given values. User must be an admin.
	 */
	setSettings: t.procedure.input(settingsSchema).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		await prisma.settings.upsert({
			where: { id: 0 },
			update: req.input,
			create: { id: 0, ...req.input },
		});
	}),

	// get all events in the schedule
	getSchedule: t.procedure.query(async (): Promise<Event[]> => {
		return await prisma.event.findMany({
			orderBy: [{ start: 'asc' }],
		});
	}),

	addScheduleEvent: t.procedure
		.input(
			z.object({
				name: z.string(),
				start: z.date(),
				end: z.date(),
				description: z.string(),
				type: z.string(),
				location: z.string(),
			})
		)
		.mutation(async (req): Promise<void> => {
			const user = await prisma.user.findUniqueOrThrow({
				where: {
					magicLink: await hash(req.ctx.magicLink),
				},
			});
			if (user.role !== Role.ADMIN) {
				throw new Error('You have insufficient permissions to perform this action.');
			}

			await prisma.event.create({
				data: { ...req.input },
			});
		}),

	deleteEvent: t.procedure.input(z.number()).mutation(async (req): Promise<void> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		await prisma.event.delete({ where: { id: req.input } });
	}),

	// get an event in schedule that matchs	id
	getEvent: t.procedure.input(z.number()).query(async (req): Promise<Event | null> => {
		const user = await prisma.user.findUniqueOrThrow({
			where: {
				magicLink: await hash(req.ctx.magicLink),
			},
		});
		if (user.role !== Role.ADMIN) {
			throw new Error('You have insufficient permissions to perform this action.');
		}
		return await prisma.event.findUnique({ where: { id: req.input } });
	}),
});

export function trpc(cookies: Cookies) {
	return router.createCaller(createContext(cookies));
}

export type Router = typeof router;
