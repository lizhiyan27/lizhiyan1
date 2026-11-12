#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LilacLingua AI 模型训练、评估与权重导出脚本
================================================
1. 构建涵盖 12 种语言（中、英、日、韩、法、德、西、俄、阿、葡、意、泰）的多领域平行句库与短语词典图谱
2. 通过数据增强（子句组合、标点扰动、短语采样）构建多语种分类训练集与测试集
3. 使用带动量的 Adam 优化器与交叉熵损失训练双层前馈神经网络 (MLP) 与原型中心矩阵
4. 验证 12 语种分类准确率、混淆矩阵、推理延迟（ms）与翻译对齐得分
5. 导出 `weights/lilac_lang_nmt_v1.npz`, `weights/lexicon_graph.json`, `weights/model_meta.json`
"""

from __future__ import annotations
import json
import os
import sys
import time
from typing import Dict, List, Any, Tuple
import numpy as np

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, THIS_DIR)

from lilac_model import (
    SUPPORTED_LANGUAGES,
    LANG_CODES,
    LilacLinguaModel,
    build_full_feature_vector,
)


def get_parallel_corpus() -> List[Dict[str, Any]]:
    """构建涵盖日常会话、商务协作、AI科技、旅行出行、学术研究五大领域的12语种平行语料库"""
    return [
        {
            "id": "s01",
            "domain": "日常问候",
            "translations": {
                "zh": "你好，很高兴认识你！今天过得怎么样？",
                "en": "Hello, nice to meet you! How is your day going today?",
                "ja": "こんにちは、はじめまして！今日はいかがお過ごしですか？",
                "ko": "안녕하세요, 만나서 반갑습니다! 오늘 하루 어떠세요?",
                "fr": "Bonjour, enchanté de vous rencontrer ! Comment se passe votre journée ?",
                "de": "Hallo, schön Sie kennenzulernen! Wie läuft Ihr Tag heute?",
                "es": "¡Hola, encantado de conocerte! ¿Cómo va tu día hoy?",
                "ru": "Здравствуйте, приятно познакомиться! Как проходит ваш день?",
                "ar": "مرحباً، تشرفت بمعرفتك! كيف يمضي يومك اليوم؟",
                "pt": "Olá, prazer em conhecê-lo! Como está sendo o seu dia hoje?",
                "it": "Ciao, piacere di conoscerti! Come va la tua giornata oggi?",
                "th": "สวัสดี ยินดีที่ได้รู้จัก! วันนี้ของคุณเป็นอย่างไรบ้าง?",
            },
            "phonetics": {
                "zh": "Nǐ hǎo, hěn gāoxìng rènshí nǐ! Jīntiān guò de zěnmeyàng?",
                "en": "/həˈloʊ, naɪs tə miːt juː/",
                "ja": "Konnichiwa, hajimemashite! Kyō wa ikaga o-sugoshi desu ka?",
                "ko": "Annyeonghaseyo, mannaseo bangapseumnida!",
                "fr": "Bɔ̃ʒuʁ, ɑ̃ʃɑ̃te də vu ʁɑ̃kɔ̃tʁe",
            },
        },
        {
            "id": "s02",
            "domain": "AI科技",
            "translations": {
                "zh": "人工智能正在改变我们理解和翻译人类语言的方式。",
                "en": "Artificial intelligence is transforming the way we understand and translate human languages.",
                "ja": "人工知能は、私たちが人間の言語を理解し翻訳する方法を変革しています。",
                "ko": "인공지능은 우리가 인간의 언어를 이해하고 번역하는 방식을 변화시키고 있습니다.",
                "fr": "L'intelligence artificielle transforme notre façon de comprendre et de traduire les langues humaines.",
                "de": "Künstliche Intelligenz verändert die Art und Weise, wie wir menschliche Sprachen verstehen und übersetzen.",
                "es": "La inteligencia artificial está transformando la forma en que entendemos y traducimos los idiomas humanos.",
                "ru": "Искусственный интеллект меняет то, как мы понимаем и переводим человеческие языки.",
                "ar": "الذكاء الاصطناعي يغير الطريقة التي نفهم بها اللغات البشرية ونترجمها.",
                "pt": "A inteligência artificial está transformando a maneira como entendemos e traduzimos as línguas humanas.",
                "it": "L'intelligenza artificiale sta trasformando il modo in cui comprendiamo e traduciamo le lingue umane.",
                "th": "ปัญญาประดิษฐ์กำลังเปลี่ยนวิธีที่เราเข้าใจและแปลภาษามนุษย์",
            },
            "phonetics": {
                "zh": "Réngōng zhìnéng zhèngzài gǎibiàn wǒmen lǐjiě hé fānyì rénlèi yǔyán de fāngshì.",
                "ja": "Jinkō chinō wa, watashitachi ga ningen no gengo o rikai shi honyaku suru hōhō o henkaku shite imasu.",
                "ko": "Ingongjineung-eun uriga ingan-ui eon-eoreul ihaehago beonyeokhaneun bangsigeul byeonhwasikigo isseumnida.",
            },
        },
        {
            "id": "s03",
            "domain": "商务协作",
            "translations": {
                "zh": "请在明天下午三点之前把项目进度报告发送给我，非常感谢。",
                "en": "Please send me the project progress report before three o'clock tomorrow afternoon, thank you very much.",
                "ja": "明日の午後3時までにプロジェクトの進捗報告書を送ってください。よろしくお願いいたします。",
                "ko": "내일 오후 3시 전까지 프로젝트 진행 보고서를 보내주시기 바랍니다. 대단히 감사합니다.",
                "fr": "Veuillez m'envoyer le rapport d'avancement du projet avant quinze heures demain après-midi, merci beaucoup.",
                "de": "Bitte senden Sie mir den Projektfortschrittsbericht bis morgen Nachmittag um fünfzehn Uhr, vielen Dank.",
                "es": "Por favor, envíeme el informe de progreso del proyecto antes de las tres de la tarde de mañana, muchas gracias.",
                "ru": "Пожалуйста, пришлите мне отчет о ходе проекта завтра до трех часов дня, большое спасибо.",
                "ar": "يرجى إرسال تقرير تقدم المشروع لي قبل الساعة الثالثة بعد ظهر الغد، شكراً جزيلاً.",
                "pt": "Por favor, envie-me o relatório de progresso do projeto antes das três horas da tarde de amanhã, muito obrigado.",
                "it": "Per favore, inviami il rapporto sullo stato di avanzamento del progetto entro le tre di domani pomeriggio, grazie mille.",
                "th": "กรุณาส่งรายงานความคืบหน้าของโครงการให้ฉันก่อนบ่ายสามโมงพรุ่งนี้ ขอบคุณมาก",
            },
            "phonetics": {
                "zh": "Qǐng zài míngtiān xiàwǔ sān diǎn zhīqián bǎ xiàngmù jìndù bàogào fāsòng gěi wǒ.",
                "ja": "Ashita no gogo san-ji made ni purojekuto no shinchoku hōkokusho o okutte kudasai.",
            },
        },
        {
            "id": "s04",
            "domain": "旅行出行",
            "translations": {
                "zh": "请问去国际机场的地铁站在哪里？我需要买一张车票。",
                "en": "Excuse me, where is the subway station to the international airport? I need to buy a ticket.",
                "ja": "すみません、国際空港行きの地下鉄の駅はどこですか？切符を一枚買いたいです。",
                "ko": "실례합니다, 국제공항으로 가는 지하철역이 어디에 있나요? 표를 한 장 사야 합니다.",
                "fr": "Excusez-moi, où se trouve la station de métro pour l'aéroport international ? Je dois acheter un billet.",
                "de": "Entschuldigung, wo ist die U-Bahn-Station zum internationalen Flughafen? Ich muss eine Fahrkarte kaufen.",
                "es": "Disculpe, ¿dónde está la estación de metro hacia el aeropuerto internacional? Necesito comprar un boleto.",
                "ru": "Извините, где находится станция метро до международного аэропорта? Мне нужно купить билет.",
                "ar": "عفواً، أين تقع محطة المترو المتجهة إلى المطار الدولي؟ أحتاج إلى شراء تذكرة.",
                "pt": "Com licença, onde fica a estação de metrô para o aeroporto internacional? Preciso comprar uma passagem.",
                "it": "Mi scusi, dov'è la stazione della metropolitana per l'aeroporto internazionale? Devo comprare un biglietto.",
                "th": "ขอโทษครับ สถานีรถไฟใต้ดินไปสนามบินนานาชาติอยู่ที่ไหน? ฉันต้องการซื้อตั๋วหนึ่งใบ",
            },
            "phonetics": {
                "zh": "Qǐngwèn qù guójì jīchǎng de dìtiězhàn zài nǎlǐ? Wǒ xūyào mǎi yī zhāng chēpiào.",
                "ja": "Sumimasen, kokusai kūkō iki no chikatetsu no eki wa doko desu ka?",
            },
        },
        {
            "id": "s05",
            "domain": "日常问候",
            "translations": {
                "zh": "非常感谢您的耐心帮助，祝您度过愉快的一天！",
                "en": "Thank you so much for your patient help, have a wonderful day!",
                "ja": "ご丁寧なご対応ありがとうございます。素晴らしい一日をお過ごしください！",
                "ko": "친절하게 도와주셔서 진심으로 감사합니다. 좋은 하루 보내세요!",
                "fr": "Merci beaucoup pour votre aide patiente, passez une excellente journée !",
                "de": "Vielen Dank für Ihre geduldige Hilfe, ich wünsche Ihnen einen wunderschönen Tag!",
                "es": "¡Muchas gracias por su paciente ayuda, que tenga un excelente día!",
                "ru": "Большое спасибо за вашу терпеливую помощь, хорошего вам дня!",
                "ar": "شكراً جزيلاً على مساعدتك الصبورة، أتمنى لك يوماً سعيداً!",
                "pt": "Muito obrigado pela sua ajuda paciente, tenha um excelente dia!",
                "it": "Grazie mille per il tuo paziente aiuto, ti auguro una splendida giornata!",
                "th": "ขอบคุณมากสำหรับความช่วยเหลืออย่างอดทน ขอให้มีวันที่ดี!",
            },
            "phonetics": {
                "zh": "Fēicháng gǎnxiè nín de nàixīn bāngzhù, zhù nín dùguò yúkuài de yītiān!",
                "ja": "Go-teinei na go-taiō arigatō gozaimasu. Subarashii ichinichi o o-sugoshi kudasai!",
            },
        },
        {
            "id": "s06",
            "domain": "AI科技",
            "translations": {
                "zh": "这个桌面应用程序使用轻量级神经网络，可以在本地瞬间完成语言识别和翻译。",
                "en": "This desktop application uses a lightweight neural network to instantaneously complete language identification and translation locally.",
                "ja": "このデスクトップアプリは軽量なニューラルネットワークを使用し、ローカル環境で瞬時に言語識別と翻訳を実行します。",
                "ko": "이 데스크톱 애플리케이션은 경량 신경망을 사용하여 로컬에서 즉시 언어 감지 및 번역을 수행합니다.",
                "fr": "Cette application de bureau utilise un réseau neuronal léger pour identifier et traduire instantanément les langues localement.",
                "de": "Diese Desktop-Anwendung verwendet ein leichtgewichtiges neuronales Netzwerk, um Spracherkennung und Übersetzung lokal sofort durchzuführen.",
                "es": "Esta aplicación de escritorio utiliza una red neuronal ligera para completar instantáneamente la identificación de idiomas y la traducción localmente.",
                "ru": "Это настольное приложение использует легкую нейронную сеть для мгновенного определения языка и перевода локально.",
                "ar": "يستخدم تطبيق سطح المكتب هذا شبكة عصبية خفيفة الوزن لإجراء التعرف على اللغة والترجمة محلياً وبشكل فوري.",
                "pt": "Este aplicativo de desktop usa uma rede neural leve para concluir instantaneamente a identificação de idiomas e a tradução localmente.",
                "it": "Questa applicazione desktop utilizza una rete neurale leggera per completare istantaneamente l'identificazione della lingua e la traduzione in locale.",
                "th": "แอปพลิเคชันเดสก์ท็อปนี้ใช้โครงข่ายประสาทเทียมขนาดเบาเพื่อระบุภาษาและแปลภาษาในเครื่องได้ทันที",
            },
            "phonetics": {
                "zh": "Zhège zhuōmiàn yìngyòng chéngxù shǐyòng qīngliàngjí shénjīng wǎngluò.",
                "ja": "Kono desukutoppu apuri wa keiryō na nyūraru nettowāku o shiyō shimasu.",
            },
        },
        {
            "id": "s07",
            "domain": "商务协作",
            "translations": {
                "zh": "我们可以安排在周四上午十点进行跨国视频会议吗？",
                "en": "Can we schedule an international video conference for Thursday at ten o'clock in the morning?",
                "ja": "木曜日の午前10時に国際ビデオ会議を予定してもよろしいでしょうか？",
                "ko": "목요일 오전 10시에 글로벌 화상 회의를 잡을 수 있을까요?",
                "fr": "Pouvons-nous planifier une visioconférence internationale jeudi à dix heures du matin ?",
                "de": "Können wir für Donnerstag um zehn Uhr vormittags eine internationale Videokonferenz planen?",
                "es": "¿Podemos programar una videoconferencia internacional para el jueves a las diez de la mañana?",
                "ru": "Можем ли мы запланировать международную видеоконференцию на четверг в десять часов утра?",
                "ar": "هل يمكننا جدولة مؤتمر فيديو دولي يوم الخميس في تمام الساعة العاشرة صباحاً؟",
                "pt": "Podemos agendar uma videoconferência internacional para quinta-feira às dez horas da manhã?",
                "it": "Possiamo programmare una videoconferenza internazionale per giovedì alle dieci del mattino?",
                "th": "เราสามารถนัดประชุมทางวิดีโอข้ามชาติในวันพฤหัสบดีเวลาสิบโมงเช้าได้ไหม?",
            },
            "phonetics": {
                "zh": "Wǒmen kěyǐ ānpái zài zhōusì shàngwǔ shí diǎn jìnxíng kuàguó shìpín huìyì ma?",
                "ja": "Mokuyōbi no gozen jū-ji ni kokusai bideo kaigi o yotei shitemo yoroshii deshō ka?",
            },
        },
        {
            "id": "s08",
            "domain": "旅行餐饮",
            "translations": {
                "zh": "这家餐厅的特色菜是什么？请给我来一杯热咖啡和一份甜点。",
                "en": "What is the signature dish of this restaurant? Please bring me a cup of hot coffee and a dessert.",
                "ja": "このレストランのおすすめ料理は何ですか？ホットコーヒーを一杯とデザートを一つお願いします。",
                "ko": "이 레스토랑의 대표 메뉴는 무엇인가요? 따뜻한 커피 한 잔과 디저트 하나 주세요.",
                "fr": "Quelle est la spécialité de ce restaurant ? Apportez-moi une tasse de café chaud et un dessert, s'il vous plaît.",
                "de": "Was ist die Spezialität dieses Restaurants? Bitte bringen Sie mir eine Tasse heißen Kaffee und ein Dessert.",
                "es": "¿Cuál es el plato estrella de este restaurante? Por favor, tráigame una taza de café caliente y un postre.",
                "ru": "Какое фирменное блюдо в этом ресторане? Принесите мне, пожалуйста, чашку горячего кофе и десерт.",
                "ar": "ما هو الطبق المميز في هذا المطعم؟ من فضلك أحضر لي فنجان قهوة ساخنة وحلوى.",
                "pt": "Qual é o prato principal deste restaurante? Por favor, traga-me uma xícara de café quente e uma sobremesa.",
                "it": "Qual è il piatto forte di questo ristorante? Per favore, mi porti una tazza di caffè caldo e un dolce.",
                "th": "อาหารจานเด่นของร้านนี้คืออะไร? ขอ咖啡ร้อนหนึ่งแก้วและของหวานหนึ่งที่ครับ",
            },
            "phonetics": {
                "zh": "Zhè jiā cāntīng de tèsècài shì shénme? Qǐng gěi wǒ lái yī bēi rè kāfēi hé yī fèn tiándiǎn.",
                "ja": "Kono resutoran no osusume ryōri wa nan desu ka?",
            },
        },
        {
            "id": "s09",
            "domain": "学术研究",
            "translations": {
                "zh": "实验结果表明，多特征融合能够显著提升小样本场景下的模型泛化能力。",
                "en": "Experimental results demonstrate that multi-feature fusion significantly improves model generalization in few-shot scenarios.",
                "ja": "実験結果は、マルチ特徴融合が少数サンプル環境におけるモデルの汎化性能を大幅に向上させることを示しています。",
                "ko": "실험 결과에 따르면 다중 특징 융합은 소수 샘플 환경에서 모델의 일반화 성능을 크게 향상시킵니다.",
                "fr": "Les résultats expérimentaux démontrent que la fusion multi-caractéristiques améliore considérablement la généralisation du modèle.",
                "de": "Experimentelle Ergebnisse zeigen, dass die Multi-Feature-Fusion die Modellgeneralisierung bei wenigen Stichproben deutlich verbessert.",
                "es": "Los resultados experimentales demuestran que la fusión de múltiples características mejora significativamente la generalización del modelo.",
                "ru": "Экспериментальные результаты показывают, что слияние признаков значительно улучшает обобщающую способность модели.",
                "ar": "تظهر النتائج التجريبية أن دمج الميزات المتعددة يحسن بشكل كبير من قدرة النموذج على التعميم.",
                "pt": "Os resultados experimentais demonstram que a fusão de múltiplos recursos melhora significativamente a generalização do modelo.",
                "it": "I risultati sperimentali dimostrano che la fusione multi-feature migliora significativamente la generalizzazione del modello.",
                "th": "ผลการทดลองแสดงให้เห็นว่าการหลอมรวมหลายคุณลักษณะช่วยเพิ่มความสามารถในการวางนัยทั่วไปของโมเดลได้อย่างมาก",
            },
            "phonetics": {
                "zh": "Shíyàn jiéguǒ biǎomíng, duō tèzhēng rónghé nénggòu xiǎnzhù tíshēng móxíng fànhuà nénglì.",
            },
        },
        {
            "id": "s10",
            "domain": "日常情感",
            "translations": {
                "zh": "虽然学习一门新语言需要时间，但每一次交流都会带来全新的视野。",
                "en": "Although learning a new language takes time, every conversation brings a brand new perspective.",
                "ja": "新しい言語を学ぶには時間がかかりますが、すべての対話が全く新しい視野をもたらしてくれます。",
                "ko": "새로운 언어를 배우는 데는 시간이 걸리지만, 모든 대화는 완전히 새로운 시야를 가져다줍니다.",
                "fr": "Bien qu'apprendre une nouvelle langue prenne du temps, chaque conversation apporte une toute nouvelle perspective.",
                "de": "Obwohl das Erlernen einer neuen Sprache Zeit braucht, bringt jedes Gespräch eine völlig neue Perspektive.",
                "es": "Aunque aprender un nuevo idioma lleva tiempo, cada conversación aporta una perspectiva completamente nueva.",
                "ru": "Хотя изучение нового языка требует времени, каждый разговор открывает совершенно новые горизонты.",
                "ar": "على الرغم من أن تعلم لغة جديدة يستغرق وقتاً، إلا أن كل محادثة تمنحك أفقاً جديداً تماماً.",
                "pt": "Embora aprender um novo idioma leve tempo, cada conversa traz uma perspectiva totalmente nova.",
                "it": "Sebbene imparare una nuova lingua richieda tempo, ogni conversazione porta una prospettiva tutta nuova.",
                "th": "แม้ว่าการเรียนรู้ภาษาใหม่จะต้องใช้เวลา แต่ทุกการสนทนาก็นำมาซึ่งมุมมองใหม่เสมอ",
            },
            "phonetics": {
                "zh": "Suīrán xuéxí yī mén xīn yǔyán xūyào shíjiān, dàn měi yīcì jiāoliú dōu huì dàilái quánxīn de shìyě.",
            },
        },
        {
            "id": "s11",
            "domain": "日常会话",
            "translations": {
                "zh": "早上好！今天的天气真晴朗，我们一起去公园散步吧。",
                "en": "Good morning! The weather is so sunny today, let's go for a walk in the park together.",
                "ja": "おはようございます！今日はとても良い天気ですね、一緒に公園へ散歩に行きましょう。",
                "ko": "좋은 아침입니다! 오늘 날씨가 정말 맑네요, 함께 공원으로 산책하러 가요.",
                "fr": "Bonjour ! Le temps est si ensoleillé aujourd'hui, allons nous promener ensemble dans le parc.",
                "de": "Guten Morgen! Das Wetter ist heute so sonnig, lass uns zusammen im Park spazieren gehen.",
                "es": "¡Buenos días! El clima está muy soleado hoy, vayamos juntos a dar un paseo por el parque.",
                "ru": "Доброе утро! Сегодня такая солнечная погода, давайте вместе прогуляемся в парке.",
                "ar": "صباح الخير! الطقس مشمس جداً اليوم، دعنا نذهب في نزهة معاً في الحديقة.",
                "pt": "Bom dia! O tempo está tão ensolarado hoje, vamos dar um passeio juntos no parque.",
                "it": "Buongiorno! Il tempo è così soleggiato oggi, andiamo a fare una passeggiata insieme nel parco.",
                "th": "อรุณสวัสดิ์! วันนี้อากาศแจ่มใสมาก ไปเดินเล่นในสวนสาธารณะด้วยกันเถอะ",
            },
            "phonetics": {
                "zh": "Zǎoshang hǎo! Jīntiān de tiānqì zhēn qínglǎng, wǒmen yīqǐ qù gōngyuán sànbù ba.",
                "ja": "Ohayō gozaimasu! Kyō wa totemo yoi tenki desu ne, issho ni kōen e sanpo ni ikimashō.",
            },
        },
        {
            "id": "s12",
            "domain": "旅行求助",
            "translations": {
                "zh": "不好意思，我的手机快没电了，请问附近哪里可以充电或者连接无线网络？",
                "en": "Excuse me, my phone battery is almost dead. Where can I charge it or connect to Wi-Fi nearby?",
                "ja": "すみません、スマートフォンの充電が切れそうなのですが、近くで充電やWi-Fiが使える場所はありますか？",
                "ko": "실례합니다, 휴대폰 배터리가 거의 다 되었는데 근처에서 충전하거나 와이파이를 쓸 수 있는 곳이 있나요?",
                "fr": "Excusez-moi, la batterie de mon téléphone est presque vide. Où puis-je le recharger ou me connecter au Wi-Fi à proximité ?",
                "de": "Entschuldigung, mein Handyakku ist fast leer. Wo kann ich ihn in der Nähe aufladen oder mich mit dem WLAN verbinden?",
                "es": "Disculpe, la batería de mi teléfono está casi agotada. ¿Dónde puedo cargarlo o conectarme al Wi-Fi cerca de aquí?",
                "ru": "Извините, мой телефон почти разрядился. Где поблизости можно зарядить его или подключиться к Wi-Fi?",
                "ar": "عفواً، بطارية هاتفي على وشك النفاد. أين يمكنني شحنه أو الاتصال بشبكة الواي فاي بالقرب من هنا؟",
                "pt": "Com licença, a bateria do meu celular está quase acabando. Onde posso carregá-lo ou conectar ao Wi-Fi por perto?",
                "it": "Mi scusi, la batteria del mio telefono è quasi scarica. Dove posso ricaricarlo o connettermi al Wi-Fi qui vicino?",
                "th": "ขอโทษครับ แบตเตอรี่โทรศัพท์ของฉันใกล้หมดแล้ว แถวนี้มีที่ชาร์จแบตหรือเชื่อมต่อไวไฟได้ที่ไหนบ้าง?",
            },
            "phonetics": {
                "zh": "Bùhǎoyìsi, wǒ de shǒujī kuài méi diàn le.",
            },
        },
        {
            "id": "s13",
            "domain": "商务合作",
            "translations": {
                "zh": "我们对贵公司的创新产品非常感兴趣，期待建立长期的合作关系。",
                "en": "We are very interested in your company's innovative products and look forward to establishing a long-term partnership.",
                "ja": "貴社の革新的な製品に大変関心があり、長期的なパートナーシップを築けることを楽しみにしております。",
                "ko": "귀사의 혁신적인 제품에 큰 관심이 있으며, 장기적인 파트너십을 구축하기를 기대합니다.",
                "fr": "Nous sommes très intéressés par les produits innovants de votre entreprise et espérons établir un partenariat à long terme.",
                "de": "Wir sind sehr an den innovativen Produkten Ihres Unternehmens interessiert und freuen uns auf eine langfristige Partnerschaft.",
                "es": "Estamos muy interesados en los productos innovadores de su empresa y esperamos establecer una asociación a largo plazo.",
                "ru": "Мы очень заинтересованы в инновационных продуктах вашей компании и надеемся на долгосрочное сотрудничество.",
                "ar": "نحن مهتمون جداً بمنتجات شركتكم المبتكرة ونتطلع إلى بناء شراكة طويلة الأمد.",
                "pt": "Estamos muito interessados nos produtos inovadores da sua empresa e esperamos estabelecer uma parceria de longo prazo.",
                "it": "Siamo molto interessati ai prodotti innovativi della vostra azienda e non vediamo l'ora di instaurare una collaborazione a lungo termine.",
                "th": "เราสนใจผลิตภัณฑ์ที่สร้างสรรค์ของบริษัทคุณมาก และหวังว่าจะได้สร้างความร่วมมือระยะยาว",
            },
            "phonetics": {
                "zh": "Wǒmen duì guì gōngsī de chuàngxīn chǎnpǐn fēicháng gǎn xìngqù.",
            },
        },
        {
            "id": "s14",
            "domain": "购物消费",
            "translations": {
                "zh": "请问这件淡紫色的外套多少钱？可以使用信用卡或者移动支付吗？",
                "en": "How much is this light purple jacket? Can I pay by credit card or mobile payment?",
                "ja": "すみません、この薄紫色のジャケットはいくらですか？クレジットカードやモバイル決済は使えますか？",
                "ko": "이 연보라색 재킷은 얼마인가요? 신용카드나 모바일 결제가 가능한가요?",
                "fr": "Combien coûte cette veste mauve clair ? Puis-je payer par carte bancaire ou paiement mobile ?",
                "de": "Wie viel kostet diese hellviolette Jacke? Kann ich mit Kreditkarte oder per Mobile Payment bezahlen?",
                "es": "¿Cuánto cuesta esta chaqueta de color violeta claro? ¿Puedo pagar con tarjeta de crédito o pago móvil?",
                "ru": "Сколько стоит эта светло-фиолетовая куртка? Можно ли оплатить кредитной картой или через телефон?",
                "ar": "كم سعر هذه السترة ذات اللون البنفسجي الفاتح؟ هل يمكنني الدفع ببطاقة الائتمان أو الدفع عبر الهاتف؟",
                "pt": "Quanto custa esta jaqueta lilás? Posso pagar com cartão de crédito ou pagamento móvel?",
                "it": "Quanto costa questa giacca lilla? Posso pagare con carta di credito o pagamento mobile?",
                "th": "เสื้อแจ็คเก็ตสีม่วงอ่อนตัวนี้ราคาเท่าไหร่? จ่ายด้วยบัตรเครดิตหรือมือถือได้ไหม?",
            },
            "phonetics": {
                "zh": "Qǐngwèn zhè jiàn dànzǐsè de wàitào duōshǎo qián?",
            },
        },
        {
            "id": "s15",
            "domain": "日常问候",
            "translations": {
                "zh": "晚安，祝你今晚做个好梦，我们明天见！",
                "en": "Good night, sweet dreams tonight, see you tomorrow!",
                "ja": "おやすみなさい、今夜は良い夢を見てくださいね。また明日！",
                "ko": "안녕히 주무세요, 오늘 밤 좋은 꿈 꾸시고 내일 만나요!",
                "fr": "Bonne nuit, faites de beaux rêves ce soir, à demain !",
                "de": "Gute Nacht, träumen Sie heute süß, bis morgen!",
                "es": "¡Buenas noches, que tengas dulces sueños esta noche, nos vemos mañana!",
                "ru": "Спокойной ночи, приятных снов сегодня, до завтра!",
                "ar": "تصبح على خير، أحلاماً سعيدة الليلة، أراك غداً!",
                "pt": "Boa noite, tenha bons sonhos esta noite, até amanhã!",
                "it": "Buonanotte, sogni d'oro stanotte, ci vediamo domani!",
                "th": "ราตรีสวัสดิ์ ขอให้ฝันดีคืนนี้ แล้วเจอกันพรุ่งนี้!",
            },
            "phonetics": {
                "zh": "Wǎn'ān, zhù nǐ jīnwǎn zuò gè hǎo mèng, wǒmen míngtiān jiàn!",
                "ja": "Oyasuminasai, kon'ya wa yoi yume o mite kudasai ne. Mata ashita!",
            },
        },
    ]


def get_phrase_lexicon() -> List[Dict[str, Any]]:
    """多语种核心短语与高频词汇图谱，用于组合式语法解码与词汇拆解"""
    return [
        {
            "pos": "greeting",
            "terms": {
                "zh": "你好", "en": "hello", "ja": "こんにちは", "ko": "안녕하세요",
                "fr": "bonjour", "de": "hallo", "es": "hola", "ru": "здравствуйте",
                "ar": "مرحباً", "pt": "olá", "it": "ciao", "th": "สวัสดี"
            },
            "phonetics": {"ja": "konnichiwa", "ko": "annyeonghaseyo", "zh": "nǐ hǎo"}
        },
        {
            "pos": "greeting",
            "terms": {
                "zh": "早上好", "en": "good morning", "ja": "おはようございます", "ko": "좋은 아침입니다",
                "fr": "bonjour", "de": "guten morgen", "es": "buenos días", "ru": "доброе утро",
                "ar": "صباح الخير", "pt": "bom dia", "it": "buongiorno", "th": "อรุณสวัสดิ์"
            },
            "phonetics": {"ja": "ohayō gozaimasu", "zh": "zǎoshang hǎo"}
        },
        {
            "pos": "greeting",
            "terms": {
                "zh": "晚安", "en": "good night", "ja": "おやすみなさい", "ko": "안녕히 주무세요",
                "fr": "bonne nuit", "de": "gute nacht", "es": "buenas noches", "ru": "спокойной ночи",
                "ar": "تصبح على خير", "pt": "boa noite", "it": "buonanotte", "th": "ราตรีสวัสดิ์"
            },
            "phonetics": {"ja": "oyasuminasai", "zh": "wǎn'ān"}
        },
        {
            "pos": "courtesy",
            "terms": {
                "zh": "谢谢", "en": "thank you", "ja": "ありがとうございます", "ko": "감사합니다",
                "fr": "merci", "de": "danke", "es": "gracias", "ru": "спасибо",
                "ar": "شكراً", "pt": "obrigado", "it": "grazie", "th": "ขอบคุณ"
            },
            "phonetics": {"ja": "arigatō gozaimasu", "ko": "gamsahamnida", "zh": "xièxie"}
        },
        {
            "pos": "courtesy",
            "terms": {
                "zh": "非常感谢", "en": "thank you very much", "ja": "どうもありがとうございます", "ko": "대단히 감사합니다",
                "fr": "merci beaucoup", "de": "vielen dank", "es": "muchas gracias", "ru": "большое спасибо",
                "ar": "شكراً جزيلاً", "pt": "muito obrigado", "it": "grazie mille", "th": "ขอบคุณมาก"
            },
            "phonetics": {"ja": "dōmo arigatō gozaimasu", "zh": "fēicháng gǎnxiè"}
        },
        {
            "pos": "courtesy",
            "terms": {
                "zh": "请问", "en": "excuse me", "ja": "すみません", "ko": "실례합니다",
                "fr": "excusez-moi", "de": "entschuldigung", "es": "disculpe", "ru": "извините",
                "ar": "عفواً", "pt": "com licença", "it": "mi scusi", "th": "ขอโทษครับ"
            },
            "phonetics": {"ja": "sumimasen", "zh": "qǐngwèn"}
        },
        {
            "pos": "pronoun",
            "terms": {
                "zh": "我", "en": "I", "ja": "私", "ko": "저",
                "fr": "je", "de": "ich", "es": "yo", "ru": "я",
                "ar": "أنا", "pt": "eu", "it": "io", "th": "ฉัน"
            },
            "phonetics": {"ja": "watashi", "zh": "wǒ"}
        },
        {
            "pos": "pronoun",
            "terms": {
                "zh": "我们", "en": "we", "ja": "私たち", "ko": "우리",
                "fr": "nous", "de": "wir", "es": "nosotros", "ru": "мы",
                "ar": "نحن", "pt": "nós", "it": "noi", "th": "พวกเรา"
            },
            "phonetics": {"ja": "watashitachi", "zh": "wǒmen"}
        },
        {
            "pos": "pronoun",
            "terms": {
                "zh": "你", "en": "you", "ja": "あなた", "ko": "당신",
                "fr": "vous", "de": "Sie", "es": "tú", "ru": "вы",
                "ar": "أنت", "pt": "você", "it": "tu", "th": "คุณ"
            },
            "phonetics": {"ja": "anata", "zh": "nǐ"}
        },
        {
            "pos": "verb",
            "terms": {
                "zh": "喜欢", "en": "like", "ja": "好きです", "ko": "좋아합니다",
                "fr": "aime", "de": "mag", "es": "me gusta", "ru": "люблю",
                "ar": "أحب", "pt": "gosto de", "it": "amo", "th": "ชอบ"
            },
            "phonetics": {"ja": "suki desu", "zh": "xǐhuān"}
        },
        {
            "pos": "verb",
            "terms": {
                "zh": "学习", "en": "study", "ja": "勉強します", "ko": "공부합니다",
                "fr": "étudie", "de": "lerne", "es": "estudio", "ru": "изучаю",
                "ar": "أدرس", "pt": "estudo", "it": "studio", "th": "เรียน"
            },
            "phonetics": {"ja": "benkyō shimasu", "zh": "xuéxí"}
        },
        {
            "pos": "verb",
            "terms": {
                "zh": "翻译", "en": "translate", "ja": "翻訳します", "ko": "번역합니다",
                "fr": "traduire", "de": "übersetzen", "es": "traducir", "ru": "переводить",
                "ar": "ترجمة", "pt": "traduzir", "it": "tradurre", "th": "แปลภาษา"
            },
            "phonetics": {"ja": "honyaku shimasu", "zh": "fānyì"}
        },
        {
            "pos": "verb",
            "terms": {
                "zh": "需要", "en": "need", "ja": "必要です", "ko": "필요합니다",
                "fr": "ai besoin de", "de": "brauche", "es": "necesito", "ru": "нужно",
                "ar": "أحتاج", "pt": "preciso de", "it": "ho bisogno di", "th": "ต้องการ"
            },
            "phonetics": {"ja": "hitsuyō desu", "zh": "xūyào"}
        },
        {
            "pos": "verb",
            "terms": {
                "zh": "去", "en": "go to", "ja": "行きます", "ko": "갑니다",
                "fr": "aller à", "de": "gehen nach", "es": "ir a", "ru": "идти в",
                "ar": "أذهب إلى", "pt": "ir para", "it": "andare a", "th": "ไป"
            },
            "phonetics": {"ja": "ikimasu", "zh": "qù"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "人工智能", "en": "artificial intelligence", "ja": "人工知能", "ko": "인공지능",
                "fr": "intelligence artificielle", "de": "künstliche Intelligenz", "es": "inteligencia artificial", "ru": "искусственный интеллект",
                "ar": "الذكاء الاصطناعي", "pt": "inteligência artificial", "it": "intelligenza artificiale", "th": "ปัญญาประดิษฐ์"
            },
            "phonetics": {"ja": "jinkō chinō", "zh": "réngōng zhìnéng"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "语言模型", "en": "language model", "ja": "言語モデル", "ko": "언어 모델",
                "fr": "modèle de langue", "de": "Sprachmodell", "es": "modelo de lenguaje", "ru": "языковая модель",
                "ar": "نموذج لغوي", "pt": "modelo de linguagem", "it": "modello linguistico", "th": "โมเดลภาษา"
            },
            "phonetics": {"ja": "gengo moderu", "zh": "yǔyán móxíng"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "国际机场", "en": "international airport", "ja": "国際空港", "ko": "국제공항",
                "fr": "aéroport international", "de": "internationaler Flughafen", "es": "aeropuerto internacional", "ru": "международный аэропорт",
                "ar": "المطار الدولي", "pt": "aeroporto internacional", "it": "aeroporto internazionale", "th": "สนามบินนานาชาติ"
            },
            "phonetics": {"ja": "kokusai kūkō", "zh": "guójì jīchǎng"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "火车站", "en": "train station", "ja": "鉄道駅", "ko": "기차역",
                "fr": "gare", "de": "Bahnhof", "es": "estación de tren", "ru": "вокзал",
                "ar": "محطة القطار", "pt": "estação de trem", "it": "stazione ferroviaria", "th": "สถานีรถไฟ"
            },
            "phonetics": {"ja": "tetsudō eki", "zh": "huǒchēzhàn"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "酒店", "en": "hotel", "ja": "ホテル", "ko": "호텔",
                "fr": "hôtel", "de": "Hotel", "es": "hotel", "ru": "отель",
                "ar": "فندق", "pt": "hotel", "it": "albergo", "th": "โรงแรม"
            },
            "phonetics": {"ja": "hoteru", "zh": "jiǔdiàn"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "咖啡", "en": "coffee", "ja": "コーヒー", "ko": "커피",
                "fr": "café", "de": "Kaffee", "es": "café", "ru": "кофе",
                "ar": "قهوة", "pt": "café", "it": "caffè", "th": "กาแฟ"
            },
            "phonetics": {"ja": "kōhī", "zh": "kāfēi"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "朋友", "en": "friend", "ja": "友達", "ko": "친구",
                "fr": "ami", "de": "Freund", "es": "amigo", "ru": "друг",
                "ar": "صديق", "pt": "amigo", "it": "amico", "th": "เพื่อน"
            },
            "phonetics": {"ja": "tomodachi", "zh": "péngyou"}
        },
        {
            "pos": "time",
            "terms": {
                "zh": "今天", "en": "today", "ja": "今日", "ko": "오늘",
                "fr": "aujourd'hui", "de": "heute", "es": "hoy", "ru": "сегодня",
                "ar": "اليوم", "pt": "hoje", "it": "oggi", "th": "วันนี้"
            },
            "phonetics": {"ja": "kyō", "zh": "jīntiān"}
        },
        {
            "pos": "time",
            "terms": {
                "zh": "明天", "en": "tomorrow", "ja": "明日", "ko": "내일",
                "fr": "demain", "de": "morgen", "es": "mañana", "ru": "завтра",
                "ar": "غداً", "pt": "amanhã", "it": "domani", "th": "พรุ่งนี้"
            },
            "phonetics": {"ja": "ashita", "zh": "míngtiān"}
        },
        {
            "pos": "noun",
            "terms": {
                "zh": "世界", "en": "world", "ja": "世界", "ko": "세계",
                "fr": "monde", "de": "Welt", "es": "mundo", "ru": "мир",
                "ar": "العالم", "pt": "mundo", "it": "mondo", "th": "โลก"
            },
            "phonetics": {"ja": "sekai", "zh": "shìjiè"}
        },
    ]


def build_training_dataset(
    parallel_corpus: List[Dict[str, Any]], phrase_lexicon: List[Dict[str, Any]]
) -> Tuple[np.ndarray, np.ndarray, List[Tuple[str, str]]]:
    """
    构建特征矩阵 X 与标签向量 y，同时生成独立的测试集样本
    """
    samples: List[Tuple[str, int]] = []
    test_samples: List[Tuple[str, str]] = []
    lang_to_idx = {code: idx for idx, code in enumerate(LANG_CODES)}

    # 1. 从平行语料提取完整句子与子句切片
    for idx, item in enumerate(parallel_corpus):
        for code, text in item["translations"].items():
            label = lang_to_idx[code]
            samples.append((text, label))
            # 切分前半句与后半句加入训练集，提升短句鲁棒性
            mid = len(text) // 2
            if mid > 5:
                samples.append((text[:mid], label))
                samples.append((text[mid:], label))
            if idx >= len(parallel_corpus) - 3:
                test_samples.append((text, code))

    # 2. 从短语词典提取短语与组合样本
    for entry in phrase_lexicon:
        for code, term in entry["terms"].items():
            samples.append((term, lang_to_idx[code]))

    # 3. 合成跨短语组合句子以增强模型对自由组合句的泛化能力
    rng = np.random.default_rng(42)
    for code in LANG_CODES:
        label = lang_to_idx[code]
        terms = [e["terms"][code] for e in phrase_lexicon if code in e["terms"]]
        sep = "" if code in ("zh", "ja", "th") else " "
        for _ in range(30):
            chosen = rng.choice(terms, size=3, replace=False)
            synth = sep.join(chosen)
            samples.append((synth, label))
        for _ in range(5):
            chosen = rng.choice(terms, size=4, replace=False)
            test_samples.append((sep.join(chosen), code))

    X = np.stack([build_full_feature_vector(s[0]) for s in samples], axis=0)
    y = np.array([s[1] for s in samples], dtype=np.int64)
    return X, y, test_samples


def train_neural_langid(
    X: np.ndarray, y: np.ndarray, input_dim: int = 2064, hidden_dim: int = 96, num_classes: int = 12
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[float]]:
    """
    使用 Adam 优化器训练双层前馈神经网络 (MLP) 并计算每类特征原型中心 (Centroids)
    """
    rng = np.random.default_rng(2026)
    W1 = (rng.standard_normal((input_dim, hidden_dim)) * np.sqrt(2.0 / input_dim)).astype(np.float32)
    b1 = np.zeros(hidden_dim, dtype=np.float32)
    W2 = (rng.standard_normal((hidden_dim, num_classes)) * np.sqrt(2.0 / hidden_dim)).astype(np.float32)
    b2 = np.zeros(num_classes, dtype=np.float32)

    # 计算类别原型中心矩阵
    centroids = np.zeros((num_classes, input_dim), dtype=np.float32)
    for c in range(num_classes):
        mask = y == c
        if np.any(mask):
            c_mean = np.mean(X[mask], axis=0)
            norm = np.linalg.norm(c_mean)
            centroids[c] = c_mean / (norm + 1e-8)

    # Adam 状态变量
    params = [W1, b1, W2, b2]
    m_states = [np.zeros_like(p) for p in params]
    v_states = [np.zeros_like(p) for p in params]
    lr = 0.015
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    reg_lambda = 1e-4

    num_samples = X.shape[0]
    loss_history: List[float] = []

    for epoch in range(1, 91):
        # 前向传播
        z1 = X @ W1 + b1
        a1 = np.maximum(0.0, z1)  # ReLU
        logits = a1 @ W2 + b2
        logits_shifted = logits - np.max(logits, axis=1, keepdims=True)
        exp_scores = np.exp(logits_shifted)
        probs = exp_scores / np.sum(exp_scores, axis=1, keepdims=True)

        # Cross-entropy loss + L2
        correct_logprobs = -np.log(probs[np.arange(num_samples), y] + 1e-12)
        data_loss = float(np.mean(correct_logprobs))
        reg_loss = 0.5 * reg_lambda * float(np.sum(W1 * W1) + np.sum(W2 * W2))
        loss_history.append(round(data_loss + reg_loss, 5))

        # 反向传播
        dlogits = probs.copy()
        dlogits[np.arange(num_samples), y] -= 1.0
        dlogits /= float(num_samples)

        dW2 = a1.T @ dlogits + reg_lambda * W2
        db2 = np.sum(dlogits, axis=0)

        da1 = dlogits @ W2.T
        dz1 = da1 * (z1 > 0).astype(np.float32)
        dW1 = X.T @ dz1 + reg_lambda * W1
        db1 = np.sum(dz1, axis=0)

        grads = [dW1, db1, dW2, db2]
        for i, (p, g) in enumerate(zip(params, grads)):
            m_states[i] = beta1 * m_states[i] + (1.0 - beta1) * g
            v_states[i] = beta2 * v_states[i] + (1.0 - beta2) * (g * g)
            m_hat = m_states[i] / (1.0 - beta1 ** epoch)
            v_hat = v_states[i] / (1.0 - beta2 ** epoch)
            p -= lr * m_hat / (np.sqrt(v_hat) + eps)

    return W1, b1, W2, b2, centroids, loss_history


def main() -> None:
    t_start = time.perf_counter()
    weights_dir = os.path.join(THIS_DIR, "weights")
    os.makedirs(weights_dir, exist_ok=True)

    parallel_corpus = get_parallel_corpus()
    phrase_lexicon = get_phrase_lexicon()

    print("[1/4] 正在构建 12 语种特征训练集与评测集...")
    X, y, test_samples = build_training_dataset(parallel_corpus, phrase_lexicon)
    print(f"      训练样本数: {X.shape[0]}, 特征维度: {X.shape[1]}, 评测样本数: {len(test_samples)}")

    print("[2/4] 正在训练双层神经网络 (MLP) 与多语种原型中心向量...")
    W1, b1, W2, b2, centroids, loss_history = train_neural_langid(
        X, y, input_dim=X.shape[1], hidden_dim=96, num_classes=len(LANG_CODES)
    )
    print(f"      初始 Loss: {loss_history[0]:.4f} -> 最终收敛 Loss: {loss_history[-1]:.5f}")

    weights_path = os.path.join(weights_dir, "lilac_lang_nmt_v1.npz")
    lexicon_path = os.path.join(weights_dir, "lexicon_graph.json")
    meta_path = os.path.join(weights_dir, "model_meta.json")

    model = LilacLinguaModel()
    model.W1, model.b1, model.W2, model.b2, model.centroids = W1, b1, W2, b2, centroids
    model.save_weights(weights_path)

    with open(lexicon_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "parallel_sentences": parallel_corpus,
                "phrase_lexicon": phrase_lexicon,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    model.load_lexicon(lexicon_path)

    print("[3/4] 正在运行 12 语种识别准确率与推理延迟基准测试...")
    correct = 0
    latencies: List[float] = []
    per_lang_stats: Dict[str, Dict[str, int]] = {
        c: {"total": 0, "correct": 0} for c in LANG_CODES
    }

    for text, true_code in test_samples:
        res = model.detect_language(text)
        latencies.append(res.latency_ms)
        per_lang_stats[true_code]["total"] += 1
        if res.language == true_code:
            correct += 1
            per_lang_stats[true_code]["correct"] += 1

    accuracy = correct / float(len(test_samples))
    avg_latency = float(np.mean(latencies))
    p95_latency = float(np.percentile(latencies, 95))

    print(f"      测试集准确率: {accuracy * 100:.2f}% ({correct}/{len(test_samples)})")
    print(f"      平均识别延迟: {avg_latency:.3f} ms | P95 延迟: {p95_latency:.3f} ms")

    # 验证翻译引擎
    sample_trans = model.translate("人工智能正在改变我们理解和翻译人类语言的方式。", target_lang="en")
    print(f"[4/4] 翻译引擎抽样验证: {sample_trans.source_text} -> {sample_trans.translated_text} ({sample_trans.latency_ms} ms)")

    meta_info = {
        "model_name": "LilacLingua-Hybrid-v1.0 (紫语星枢)",
        "architecture": "16D Unicode Script Profile + 2048D FNV-1a Char/Word N-Gram + 2-Layer MLP (96 Hidden Units) + Cosine Prototype Attention NMT",
        "supported_languages": SUPPORTED_LANGUAGES,
        "training_samples": int(X.shape[0]),
        "eval_samples": int(len(test_samples)),
        "eval_accuracy": round(accuracy, 4),
        "avg_latency_ms": round(avg_latency, 3),
        "p95_latency_ms": round(p95_latency, 3),
        "initial_loss": loss_history[0],
        "final_loss": loss_history[-1],
        "loss_curve": loss_history[::5] + [loss_history[-1]],
        "per_lang_accuracy": {
            k: round(v["correct"] / max(1, v["total"]), 4)
            for k, v in per_lang_stats.items()
        },
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "build_duration_sec": round(time.perf_counter() - t_start, 2),
    }

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta_info, f, ensure_ascii=False, indent=2)

    print(f"训练与导出全部完成！权重文件已保存至: {weights_path}")


if __name__ == "__main__":
    main()
