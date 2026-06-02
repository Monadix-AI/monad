import type { ChannelSetupGuide } from '@monad/protocol';

export const channelSetupGuides = {
  telegram: {
    summary: 'Create a Telegram bot, then connect it with the token issued by BotFather.',
    steps: [
      'Open @BotFather in Telegram and run /newbot.',
      'Copy the bot token BotFather returns.',
      'Paste the token below, save the connection, then switch it on.'
    ],
    docsUrl: 'https://core.telegram.org/bots/tutorial'
  },
  discord: {
    summary: 'Create a Discord application with a bot user and enable the intents required to receive messages.',
    steps: [
      'Create an application in the Discord Developer Portal and add a bot user.',
      'Enable Message Content Intent, then copy the bot token.',
      'Invite the bot to your server, paste the token below, and switch the connection on.'
    ],
    docsUrl: 'https://discord.com/developers/docs/quick-start/getting-started'
  },
  slack: {
    summary: 'Use a Slack app in Socket Mode with both a bot token and an app-level token.',
    steps: [
      'Create a Slack app, add the required bot scopes, and install it to your workspace.',
      'Enable Socket Mode and create an app-level token with connections:write.',
      'Paste the xoxb bot token and xapp app token below, then switch the connection on.'
    ],
    docsUrl: 'https://api.slack.com/start/quickstart'
  },
  email: {
    summary: 'Connect a mailbox through IMAP for incoming mail and SMTP for replies.',
    steps: [
      'Enable IMAP and SMTP access for the mailbox and create an app password when required.',
      'Enter the mailbox address plus its IMAP and SMTP hosts below.',
      'Enter the mailbox password below, save, and switch the connection on.'
    ]
  },
  feishu: {
    summary: 'Create a Feishu or Lark app, enable bot messaging, and route events to Monad.',
    steps: [
      'Create an app in the Feishu/Lark developer console and enable the bot capability.',
      'Configure the event callback URL for the /feishu endpoint exposed by Monad.',
      'Paste the App ID and App Secret below, save, and switch the connection on.'
    ],
    docsUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot'
  },
  gchat: {
    summary: 'Create a Google Chat app backed by a service account and route Chat events to Monad.',
    steps: [
      'Create a Google Cloud project, enable the Google Chat API, and configure a Chat app.',
      'Create a service-account key and configure the app endpoint for Monad’s /gchat callback.',
      'Paste the complete service-account JSON below, save, and switch the connection on.'
    ],
    docsUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks'
  },
  imessage: {
    summary: 'Run BlueBubbles Server on a Mac and connect Monad to its REST API and webhook.',
    steps: [
      'Install and configure BlueBubbles Server on the Mac that owns the Messages account.',
      'Enter the BlueBubbles server URL below and configure its webhook for /imessage.',
      'Enter the BlueBubbles server password below, save, and switch the connection on.'
    ],
    docsUrl: 'https://docs.bluebubbles.app/server/basic-guides/installation'
  },
  irc: {
    summary: 'Connect Monad directly to an IRC server and join one or more channels.',
    steps: [
      'Choose the IRC server, port, nickname, and channels the bot should join.',
      'Enter the server host, port, nickname, and comma-separated channels below.',
      'Save the connection and switch it on; TLS is enabled unless the TLS field is false.'
    ],
    docsUrl: 'https://modern.ircdocs.horse/'
  },
  line: {
    summary: 'Create a LINE Messaging API channel and connect its signed webhook to Monad.',
    steps: [
      'Create a Messaging API channel in the LINE Developers Console.',
      'Set its webhook URL to the /line endpoint exposed by Monad and enable webhooks.',
      'Paste the channel access token and channel secret below, then switch the connection on.'
    ],
    docsUrl: 'https://developers.line.biz/en/docs/messaging-api/getting-started/'
  },
  qq: {
    summary: 'Create a QQ Bot application and connect it through the QQ gateway.',
    steps: [
      'Create a bot in the QQ Open Platform and enable the message intents you need.',
      'Copy the App ID and bot token; copy the client secret if your app requires it.',
      'Enter the credentials below, save, and switch the connection on.'
    ],
    docsUrl: 'https://bot.q.qq.com/wiki/'
  },
  signal: {
    summary: 'Register a Signal account with signal-cli before enabling this connection.',
    steps: [
      'Install signal-cli and register or link the account Monad should use.',
      'Enter the registered phone number and optional signal-cli path below.',
      'Save the connection and switch it on.'
    ],
    docsUrl: 'https://github.com/AsamK/signal-cli'
  },
  teams: {
    summary: 'Register a Microsoft Bot application and route Teams Bot Framework activities to Monad.',
    steps: [
      'Create an Azure bot registration and add the Microsoft Teams channel.',
      'Configure its messaging endpoint for the /teams endpoint exposed by Monad.',
      'Paste the Microsoft App ID and password below, save, and switch the connection on.'
    ],
    docsUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams'
  },
  twilio: {
    summary: 'Connect a Twilio phone number for inbound and outbound SMS or WhatsApp messages.',
    steps: [
      'Choose a Twilio number and configure its incoming-message webhook for Monad’s /twilio endpoint.',
      'Enter that sender number below.',
      'Enter the Account SID and Auth Token below, save, and switch the connection on.'
    ],
    docsUrl: 'https://www.twilio.com/docs/messaging/tutorials/how-to-receive-and-reply'
  },
  webhook: {
    summary: 'Receive normalized messages over HTTP and optionally forward replies to another endpoint.',
    steps: [
      'Expose the configured inbound port and path to the system that will send messages.',
      'Enter an outbound URL below when replies should be delivered to an HTTP endpoint.',
      'Configure a shared signing secret, save the connection, and switch it on.'
    ]
  },
  wecom: {
    summary: 'Create a WeCom self-built app and connect its encrypted callback to Monad.',
    steps: [
      'Create a self-built app in WeCom and note its Corp ID, Agent ID, secret, token, and AES key.',
      'Enter the Agent ID below and configure the app callback for Monad’s /wecom endpoint.',
      'Enter the credentials below, save, and switch the connection on.'
    ],
    docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770'
  },
  whatsapp: {
    summary: 'Link a WhatsApp account as a companion device by scanning a QR code.',
    steps: [
      'Use a dedicated WhatsApp number when possible; WhatsApp Web automation is unofficial and can carry account risk.',
      'Save the connection, then scan the QR code from WhatsApp → Settings → Linked Devices.',
      'Keep Monad running so the linked device can receive and reply to messages.'
    ],
    docsUrl: 'https://faq.whatsapp.com/1317564962315842'
  },
  whatsappBusiness: {
    summary: 'Connect a WhatsApp Business Cloud API phone number and its signed Meta webhook.',
    steps: [
      'Create a WhatsApp app in Meta for Developers and add a Cloud API phone number.',
      'Enter the phone number ID below and configure the webhook for Monad’s /whatsapp-business endpoint.',
      'Paste the permanent access token and app secret below, save, and switch the connection on.'
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started'
  }
} satisfies Record<string, ChannelSetupGuide>;
