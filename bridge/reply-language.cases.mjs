// Labelled short lines for the language detector (bridge/reply-language.mjs): what a player types to an NPC, two to six words.
// DEV is the set the detector was tuned on; HELDOUT (bridge/reply-language.heldout.json) was written separately and never used to tune.
// Format: [text, language]. 'en' is English; null would mean "no call is fine" and is not used here.
// "choom"-style Night City words inside a sentence do not change the language of the sentence: "¿qué pasa, choom?" is Spanish.

export const DEV = [
  // French
  ['Combien de temps encore ?', 'fr'], ['Tu viens avec moi ?', 'fr'], ['Où est-ce qu\'on va ?', 'fr'], ['Merci pour ton aide', 'fr'],
  ['Je ne comprends pas', 'fr'], ['On y va maintenant', 'fr'], ['C\'est quoi ton problème ?', 'fr'], ['Hé choom, tu viens ?', 'fr'],
  ['Arrête la voiture', 'fr'], ['J\'ai besoin de tes conseils', 'fr'], ['Bonne nuit, Judy', 'fr'], ['Quelle heure est-il ?', 'fr'],
  ['Je suis fatigué', 'fr'], ['Vous avez des armes ?', 'fr'],
  // Italian
  ['Siamo quasi arrivati?', 'it'], ['Dove stiamo andando?', 'it'], ['Non capisco niente', 'it'], ['Grazie mille per tutto', 'it'],
  ['Ho bisogno di aiuto', 'it'], ['Che cosa vuoi da me?', 'it'], ['Andiamo via di qui', 'it'], ['Quanto costa questa pistola?', 'it'],
  ['Buonanotte Panam', 'it'], ['Fermati subito', 'it'], ['Sono stanco morto', 'it'], ['Parli italiano?', 'it'],
  // Spanish
  ['¿Cuánto falta?', 'es'], ['No entiendo nada', 'es'], ['¿Qué pasa, choom?', 'es'], ['Vámonos de aquí', 'es'],
  ['Gracias por todo, Jackie', 'es'], ['¿Dónde está el Afterlife?', 'es'], ['Necesito tu ayuda', 'es'], ['Para el coche ahora',  'es'],
  ['Estoy muy cansado', 'es'], ['¿Quieres venir conmigo?', 'es'], ['Buenas noches', 'es'], ['Hola, ¿cómo estás?', 'es'],
  ['Me duele la cabeza', 'es'], ['¿Cuánto cuesta esto?', 'es'],
  // German
  ['Wie lange noch?', 'de'], ['Ich verstehe das nicht', 'de'], ['Wo gehen wir hin?', 'de'], ['Danke für deine Hilfe', 'de'],
  ['Komm mit mir', 'de'], ['Halt das Auto an', 'de'], ['Was willst du von mir?', 'de'], ['Gute Nacht, Judy', 'de'],
  ['Ich bin müde', 'de'], ['Hast du eine Waffe?', 'de'], ['Wir müssen los', 'de'], ['Sprichst du Deutsch?', 'de'],
  // Portuguese
  ['Quanto tempo falta?', 'pt'], ['Não entendo nada', 'pt'], ['Obrigado pela ajuda', 'pt'], ['Para onde vamos agora?', 'pt'],
  ['Preciso da sua ajuda', 'pt'], ['Estou muito cansado', 'pt'], ['Vamos embora daqui', 'pt'], ['Você fala português?', 'pt'],
  ['Boa noite, Panam', 'pt'], ['Quanto custa isso?', 'pt'], ['Para o carro agora', 'pt'], ['Tenho uma arma',  'pt'],
  // Dutch
  ['Hoe lang nog?', 'nl'], ['Ik begrijp het niet', 'nl'], ['Waar gaan we heen?', 'nl'], ['Dank je wel', 'nl'], ['Ik ben moe', 'nl'],
  // Polish
  ['Jak długo jeszcze?', 'pl'], ['Nie rozumiem tego', 'pl'], ['Dokąd jedziemy?', 'pl'], ['Dziękuję za pomoc', 'pl'],
  // Czech, Hungarian, Turkish, Swedish
  ['Jak dlouho ještě?', 'cs'], ['Nerozumím tomu', 'cs'],
  ['Mennyi idő van még?', 'hu'], ['Nem értem ezt', 'hu'],
  ['Ne kadar kaldı?', 'tr'], ['Bunu anlamıyorum', 'tr'], ['Teşekkürler dostum', 'tr'],
  ['Hur länge till?', 'sv'], ['Jag förstår inte', 'sv'],
  // Romanian, Catalan, Norwegian, Vietnamese
  ['Cât mai e până acolo?', 'ro'], ['Nu înțeleg nimic', 'ro'],
  ['Quant falta encara?', 'ca'], ['No ho entenc', 'ca'],
  ['Hvor lenge til?', 'no'], ['Jeg forstår ikke', 'no'],
  ['Còn bao lâu nữa?', 'vi'],
  // Other scripts
  ['Сколько еще ехать?', 'ru'], ['Я не понимаю', 'ru'], ['Скільки ще їхати?', 'uk'], ['Дякую за допомогу', 'uk'],
  ['まだ着かないの？', 'ja'], ['ありがとう', 'ja'], ['还要多久？', 'zh'], ['我不明白', 'zh'], ['아직 멀었어요?', 'ko'], ['고마워요', 'ko'],
  ['Πόσο ακόμα;', 'el'], ['كم بقي من الوقت؟', 'ar'], ['כמה זמן עוד?', 'he'], ['कितना समय और लगेगा?', 'hi'], ['อีกนานไหม', 'th'],

  // English: plain short chat
  ['how long until we get there', 'en'], ['ok', null], ['yes', 'en'], ['nah', null], ['go', null], ['let\'s ride', 'en'],
  ['who are you', 'en'], ['I don\'t understand', 'en'], ['where are we going', 'en'], ['thanks for the help', 'en'],
  ['stop the car', 'en'], ['what do you want from me', 'en'], ['good night Judy', 'en'], ['are we there yet', 'en'],
  ['I need your help', 'en'], ['come with me', 'en'], ['what time is it', 'en'], ['how much is this gun', 'en'],
  ['do you have a weapon', 'en'], ['I am tired', 'en'], ['take me home', 'en'], ['nice ride', 'en'], ['drive faster', 'en'],
  ['not now', 'en'], ['no way', 'en'], ['hell yes', 'en'], ['sure thing', 'en'], ['right here is fine', 'en'], ['wait for me', 'en'],
  ['Hello', 'en'], ['Hi Jackie', 'en'], ['hey', null], ['What?', 'en'], ['help', null], ['why', null], ['one more minute', 'en'],
  // English: Night City words and names
  ['preem gig choom', null], ['Afterlife tonight?', null], ['nova ride Delamain', null], ['gonk move Jackie', null],
  ['Misty\'s shop is closed', 'en'], ['sell me some eddies', 'en'], ['Arasaka dogs', null], ['hey Johnny', 'en'],
  ['chipping in?', null], ['Jackie, what\'s the plan?', 'en'], ['Take me to Afterlife', 'en'], ['Misty', null], ['Arasaka', null],
  ['Delamain, how long?', 'en'], ['That was a preem gig, choom', 'en'], ['nova, let\'s go', 'en'], ['you gonk', null],
  ['I owe Viktor some eddies', 'en'], ['Panam and the Aldecaldos', 'en'], ['the netrunner is waiting', 'en'],
  // English: with one Spanish or Japanese nickname
  ['hey hermano what\'s up', 'en'], ['thanks amigo see you', 'en'], ['ok chica let\'s go', 'en'], ['sayonara see you later', 'en'],
  ['Ay chica, let\'s go', 'en'], ['vato, where are we going', 'en'], ['arigato, that helps', 'en'],
  // English: fragments
  ['lol', null], ['hmm', null], ['ETA?', null], ['yo', null], ['thx', null], ['123', null], ['...', null], ['👍', null],
  ['[Microphone]', null], ['V', null],
];
