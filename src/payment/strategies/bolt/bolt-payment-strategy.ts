import { CheckoutStore, InternalCheckoutSelectors } from '../../../checkout';
import { InvalidArgumentError, MissingDataError, MissingDataErrorType, NotInitializedError, NotInitializedErrorType } from '../../../common/error/errors';
import { OrderActionCreator, OrderRequestBody } from '../../../order';
import { OrderFinalizationNotRequiredError } from '../../../order/errors';
import { StoreCreditActionCreator } from '../../../store-credit';
import { PaymentArgumentInvalidError, PaymentMethodCancelledError, PaymentMethodInvalidError } from '../../errors';
import { NonceInstrument } from '../../payment';
import PaymentActionCreator from '../../payment-action-creator';
import PaymentMethodActionCreator from '../../payment-method-action-creator';
import { PaymentInitializeOptions, PaymentRequestOptions } from '../../payment-request-options';
import PaymentStrategy from '../payment-strategy';

import { BoltCheckout, BoltEmbedded, BoltEmbeddedTokenize, BoltEmbededField, BoltTransaction } from './bolt';
import BoltScriptLoader from './bolt-script-loader';

export default class BoltPaymentStrategy implements PaymentStrategy {
    private _boltClient?: BoltCheckout;
    private _boltEmbedded?: BoltEmbedded;
    private _embeddedField?: BoltEmbededField;
    private _useBoltClient: boolean = false;
    private _useBoltEmbedded: boolean = false;

    constructor(
        private _store: CheckoutStore,
        private _orderActionCreator: OrderActionCreator,
        private _paymentActionCreator: PaymentActionCreator,
        private _paymentMethodActionCreator: PaymentMethodActionCreator,
        private _storeCreditActionCreator: StoreCreditActionCreator,
        private _boltScriptLoader: BoltScriptLoader
    ) { }

    async initialize(options: PaymentInitializeOptions): Promise<InternalCheckoutSelectors> {
        const { bolt, methodId } = options;

        if (!methodId) {
            throw new InvalidArgumentError('Unable to initialize payment because "options.methodId" argument is not provided.');
        }

        if (bolt?.useBigCommerceCheckout) {
            const state = this._store.getState();
            const paymentMethod = state.paymentMethods.getPaymentMethod(methodId);

            const { initializationData, config } = paymentMethod || {};
            const { publishableKey, developerConfig, embeddedOneClickEnabled } = initializationData || {};
            const { testMode } = config || {};

            if (!paymentMethod || !publishableKey) {
                throw new MissingDataError(MissingDataErrorType.MissingPaymentMethod);
            }

            this._boltClient = await this._boltScriptLoader.loadBoltClient(publishableKey, testMode, developerConfig);

            this._useBoltClient = bolt.useBigCommerceCheckout && !embeddedOneClickEnabled;
            this._useBoltEmbedded = bolt.useBigCommerceCheckout && embeddedOneClickEnabled;

            if (this._useBoltEmbedded) {
                if (!bolt.containerId) {
                    throw new InvalidArgumentError('Unable to initialize payment because "options.bolt.containerId" argument is not provided.');
                }

                this._boltEmbedded = await this._boltScriptLoader.loadBoltEmbedded(publishableKey, testMode, developerConfig);
                this._mountBoltEmbeddedField(bolt.containerId);
            }
        } else {
            this._boltClient = await this._boltScriptLoader.loadBoltClient();
        }

        return Promise.resolve(this._store.getState());
    }

    deinitialize(): Promise<InternalCheckoutSelectors> {
        this._boltClient = undefined;
        this._boltEmbedded = undefined;

        return Promise.resolve(this._store.getState());
    }

    finalize(): Promise<InternalCheckoutSelectors> {
        return Promise.reject(new OrderFinalizationNotRequiredError());
    }

    async execute(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<InternalCheckoutSelectors> {
        if (this._useBoltClient) {
            return this._executeWithBoltClient(payload, options);
        }

        if (this._useBoltEmbedded) {
            return this._executeWithBoltEmbedded(payload, options);
        }

        return this._executeWithBoltFullCheckout(payload, options);
    }

    /**
     * The method triggers when Bolt have 'Fraud Protection Only' configuration mode enabled
     *
     * @param payload OrderRequestBody
     * @param options PaymentRequestOptions
     * @returns Promise<InternalCheckoutSelectors>
     */
    private async _executeWithBoltClient(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<InternalCheckoutSelectors> {
        const { payment, ...order } = payload;
        const boltClient = this._getBoltClient();

        if (!payment) {
            throw new PaymentArgumentInvalidError(['payment']);
        }

        await this._store.dispatch(this._orderActionCreator.submitOrder(order, options));

        const { isStoreCreditApplied: useStoreCredit } = this._store.getState().checkout.getCheckoutOrThrow();

        if (useStoreCredit !== undefined) {
            await this._store.dispatch(this._storeCreditActionCreator.applyStoreCredit(useStoreCredit));
        }

        const state = await this._store.dispatch(this._paymentMethodActionCreator.loadPaymentMethod(payment.methodId, options));
        const paymentMethod = state.paymentMethods.getPaymentMethod(payment.methodId);

        if (!paymentMethod || !paymentMethod.clientToken) {
            throw new MissingDataError(MissingDataErrorType.MissingPaymentMethod);
        }

        const orderToken = paymentMethod.clientToken;

        const transaction: BoltTransaction = await new Promise((resolve, reject) => {
            const onSuccess = (transaction: BoltTransaction,  callback: () => void) => {
                resolve(transaction);
                callback();
            };

            const onClose = () => {
                reject(new PaymentMethodCancelledError());
            };

            const callbacks = {
                success: onSuccess,
                close: onClose,
            };

            boltClient.configure({ orderToken }, {}, callbacks).open();
        });

        const { shouldSaveInstrument } = payment.paymentData as NonceInstrument;

        const paymentPayload = {
            methodId: payment.methodId,
            paymentData: {
                nonce: transaction.reference,
                shouldSaveInstrument,
            },
        };

        return this._store.dispatch(this._paymentActionCreator.submitPayment(paymentPayload));
    }

    /**
     * The method triggers when Bolt have 'Embed One Click' configuration mode enabled
     * and temporary for 'Bolt Accounts' configuration mode too
     *
     * @param payload OrderRequestBody
     * @param options PaymentRequestOptions
     * @returns Promise<InternalCheckoutSelectors>
     */
    private async _executeWithBoltEmbedded(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<InternalCheckoutSelectors> {
        const { payment, ...order } = payload;

        if (!payment) {
            throw new PaymentArgumentInvalidError(['payment']);
        }

        const tokenizeResult = await this._embeddedField?.tokenize();

        if (!tokenizeResult) {
            throw new PaymentMethodInvalidError();
        }

        if (tokenizeResult instanceof Error) {
            throw tokenizeResult;
        }

        this._validateTokenizeResult(tokenizeResult);

        await this._store.dispatch(this._orderActionCreator.submitOrder(order, options));

        const paymentPayload = {
            methodId: payment.methodId,
            paymentData: {
                formattedPayload: {
                    credit_card_token: {
                        token: tokenizeResult.token,
                        last_four_digits: +tokenizeResult.last4,
                        iin: +tokenizeResult.bin,
                        expiration_month: +tokenizeResult.expiration.split('-')[1],
                        expiration_year: +tokenizeResult.expiration.split('-')[0],
                    },
                    provider_data: {
                        create_account: false,
                        embedded_checkout: true,
                    },
                },
            },
        };

        return this._store.dispatch(this._paymentActionCreator.submitPayment(paymentPayload));
    }

    /**
     * The method triggers when Bolt have 'Full Checkout with Fraud Protection' configuration mode enabled
     *
     * @param payload OrderRequestBody
     * @param options PaymentRequestOptions
     * @returns Promise<InternalCheckoutSelectors>
     */
    private async _executeWithBoltFullCheckout(payload: OrderRequestBody, options?: PaymentRequestOptions): Promise<InternalCheckoutSelectors> {
        const { payment, ...order } = payload;
        const boltClient = this._getBoltClient();

        if (!payment) {
            throw new PaymentArgumentInvalidError(['payment']);
        }

        const { methodId, paymentData } = payment;

        if (!methodId) {
            throw new MissingDataError(MissingDataErrorType.MissingPaymentMethod);
        }

        if (!paymentData) {
            throw new MissingDataError(MissingDataErrorType.MissingPayment);
        }

        await this._store.dispatch(this._orderActionCreator.submitOrder(order, options));

        const transactionReference = await boltClient.getTransactionReference();

        if (!transactionReference) {
            throw new PaymentMethodInvalidError();
        }

        return this._store.dispatch(this._paymentActionCreator.submitPayment({
            methodId,
            paymentData: {
                ...paymentData,
                nonce: transactionReference,
            },
        }));
    }

    private _getBoltClient() {
        const boltClient = this._boltClient;

        if (!boltClient) {
            throw new NotInitializedError(NotInitializedErrorType.PaymentNotInitialized);
        }

        return boltClient;
    }

    private _getBoltEmbedded() {
        const boltEmbedded = this._boltEmbedded;

        if (!boltEmbedded) {
            throw new NotInitializedError(NotInitializedErrorType.PaymentNotInitialized);
        }

        return boltEmbedded;
    }

    private _mountBoltEmbeddedField(containerId: string) {
        const boltEmbedded = this._getBoltEmbedded();

        const embeddedField = boltEmbedded.create('payment_field');
        embeddedField.mount(`#${containerId}`);

        this._embeddedField = embeddedField;
    }

    private _validateTokenizeResult(tokenizeResult: BoltEmbeddedTokenize) {
        const { token, last4, bin, expiration } = tokenizeResult;
        const lastFourDigits = +last4;
        const iin = +bin;
        const expirationMonth = +('' + expiration).split('-')[1];
        const expirationYear = +('' + expiration).split('-')[0];

        if (
            !token
            || isNaN(lastFourDigits)
            || isNaN(iin)
            || isNaN(expirationMonth)
            || isNaN(expirationYear)
        ) {
            throw new PaymentArgumentInvalidError();
        }
    }
}
